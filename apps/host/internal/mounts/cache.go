package mounts

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ChunkSize is the cache's unit: an object is fetched and kept in chunks of this many bytes (the last one shorter),
// so a large file read in part fetches only the parts read.
const ChunkSize int64 = 8 << 20

// Cache is the host's read cache of bucket objects, shared by every sandbox on the host. It holds chunks of objects
// on disk under its directory, named by a digest of the object's identity (store, bucket, key, version and the
// credential that read it) and the chunk's index, and evicts the least recently used once it holds more than its
// limit. A chunk is fetched once however many sandboxes ask for it at the same time.
type Cache struct {
	dir string
	max int64

	mu      sync.Mutex
	used    int64
	entries map[string]*list.Element
	lru     *list.List
	flight  map[string]*fetch

	Hits   atomic.Int64
	Misses atomic.Int64
}

type cacheEntry struct {
	name string
	size int64
}

type fetch struct {
	done chan struct{}
	err  error
}

// FetchTimeout bounds one chunk's fetch from the store, whoever is waiting for it.
const FetchTimeout = 2 * time.Minute

// OpenCache opens (or makes) the cache in dir, holding at most maxBytes, and takes in the chunks a previous run left
// there, oldest first.
func OpenCache(dir string, maxBytes int64) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	c := &Cache{dir: dir, max: maxBytes, entries: map[string]*list.Element{}, lru: list.New(), flight: map[string]*fetch{}}
	type found struct {
		name string
		size int64
		mod  time.Time
	}
	var all []found
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".tmp") {
			_ = os.Remove(path)
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		all = append(all, found{name: d.Name(), size: info.Size(), mod: info.ModTime()})
		return nil
	})
	sort.Slice(all, func(i, j int) bool { return all[i].mod.Before(all[j].mod) })
	for _, f := range all {
		c.entries[f.name] = c.lru.PushFront(&cacheEntry{name: f.name, size: f.size})
		c.used += f.size
	}
	c.mu.Lock()
	c.evict("")
	c.mu.Unlock()
	return c, nil
}

// ObjectID is what the cache knows an object by. The credential's key ID is part of it: two sources share an
// object's cached bytes only when they read it as the same principal.
func ObjectID(endpoint, bucket, key, version, credential string) string {
	h := sha256.Sum256([]byte(strings.Join([]string{endpoint, bucket, key, version, credential}, "\x00")))
	return hex.EncodeToString(h[:])
}

func (c *Cache) chunkName(id string, index int64) string {
	return id + "-" + strconv.FormatInt(index, 10)
}

func (c *Cache) path(name string) string { return filepath.Join(c.dir, name[:2], name) }

// Used is how many bytes the cache holds now.
func (c *Cache) Used() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.used
}

// Cached says whether a chunk is in the cache, without fetching it.
func (c *Cache) Cached(id string, index int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.entries[c.chunkName(id, index)]
	return ok
}

// Chunk opens a chunk of an object, fetching it with get when it isn't cached (get answers the chunk's bytes).
// The caller closes the file; an eviction meanwhile doesn't take the bytes from under it.
func (c *Cache) Chunk(ctx context.Context, id string, index int64, get func(ctx context.Context) (io.ReadCloser, error)) (*os.File, error) {
	name := c.chunkName(id, index)
	for attempt := 0; ; attempt++ {
		c.mu.Lock()
		if el, ok := c.entries[name]; ok {
			c.lru.MoveToFront(el)
			f, err := os.Open(c.path(name))
			if err == nil {
				c.mu.Unlock()
				c.Hits.Add(1)
				return f, nil
			}
			// Gone from the disk under the cache: forget it and fetch it again.
			c.remove(el)
		}
		if fl, ok := c.flight[name]; ok {
			c.mu.Unlock()
			select {
			case <-fl.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if fl.err != nil {
				return nil, fl.err
			}
			if attempt > 2 {
				return nil, errors.New("the cache lost a chunk as it was fetched")
			}
			continue
		}
		fl := &fetch{done: make(chan struct{})}
		c.flight[name] = fl
		c.mu.Unlock()
		c.Misses.Add(1)
		// Not the asker's context: others may be waiting for the same chunk.
		fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), FetchTimeout)
		size, err := c.store(fetchCtx, name, get)
		cancel()
		var f *os.File
		if err == nil {
			// Opened before it is in the cache's index, so no eviction can take it from the fetcher.
			f, err = os.Open(c.path(name))
		}
		c.mu.Lock()
		delete(c.flight, name)
		if err == nil {
			if old, ok := c.entries[name]; ok {
				c.remove(old)
			}
			c.entries[name] = c.lru.PushFront(&cacheEntry{name: name, size: size})
			c.used += size
			c.evict(name)
		}
		fl.err = err
		close(fl.done)
		c.mu.Unlock()
		return f, err
	}
}

// store writes a chunk to a temporary file and renames it into place.
func (c *Cache) store(ctx context.Context, name string, get func(ctx context.Context) (io.ReadCloser, error)) (int64, error) {
	body, err := get(ctx)
	if err != nil {
		return 0, err
	}
	defer body.Close()
	final := c.path(name)
	if err := os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(final), name+".*.tmp")
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(tmp, io.LimitReader(body, ChunkSize+1))
	if err == nil && n > ChunkSize {
		err = fmt.Errorf("the store sent more than a chunk")
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), final)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return 0, err
	}
	return n, nil
}

// evict drops the least recently used chunks until the cache is within its limit, keeping keep. Called with mu.
func (c *Cache) evict(keep string) {
	for c.used > c.max {
		el := c.lru.Back()
		if el == nil {
			return
		}
		e := el.Value.(*cacheEntry)
		if e.name == keep {
			if c.lru.Len() == 1 {
				return
			}
			c.lru.MoveToFront(el)
			continue
		}
		c.remove(el)
		_ = os.Remove(c.path(e.name))
	}
}

func (c *Cache) remove(el *list.Element) {
	e := el.Value.(*cacheEntry)
	c.lru.Remove(el)
	delete(c.entries, e.name)
	c.used -= e.size
}
