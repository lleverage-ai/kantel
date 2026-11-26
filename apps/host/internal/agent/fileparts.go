package agent

import (
	"context"
	"encoding/base64"
	"fmt"
	"path"
	"regexp"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Files in parts (sandbox.files.part, .complete and .abort; FeatureFileParts): a large file written a part at a time
// into a staged file beside it, which moves into place only once its size and SHA-256 are checked. Each part is one
// call, so it is relayed between gateway replicas as any call is, and kept small (proto.FilePartMaxBytes).

// FilePartWriter is a tier that takes files in parts. A tier without it answers the calls as unsupported.
type FilePartWriter interface {
	WriteFilePart(ctx context.Context, p proto.FilePartParams, data []byte) (int64, error)
	CompleteFileParts(ctx context.Context, p proto.FilePartParams) (int64, uint32, error)
	AbortFileParts(ctx context.Context, p proto.FilePartParams) error
}

var (
	filePartUpload = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	filePartSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// filePartWriter is the tier holding a sandbox, as a FilePartWriter.
func (h *Host) filePartWriter(sandboxID string) (FilePartWriter, error) {
	t, name, err := h.tierOfNamed(sandboxID)
	if err != nil {
		return nil, err
	}
	w, ok := t.(FilePartWriter)
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s sandboxes don't take files in parts", name)}
	}
	return w, nil
}

// fileParts serves sandbox.files.part, .complete and .abort.
func (h *Host) fileParts(ctx context.Context, method string, p proto.FilePartParams) (any, error) {
	switch {
	case !path.IsAbs(p.Path) || path.Clean(p.Path) == "/":
		return nil, invalid("%s needs an absolute path to a file, not %q", method, p.Path)
	case !filePartUpload.MatchString(p.Upload):
		return nil, invalid("%s's upload is 8 to 64 letters, digits, - or _, not %q", method, p.Upload)
	}
	w, err := h.filePartWriter(p.SandboxID)
	if err != nil {
		return nil, err
	}
	switch method {
	case proto.MethodFilePart:
		if p.Offset < 0 {
			return nil, invalid("offset can't be negative")
		}
		if base64.StdEncoding.DecodedLen(len(p.Data)) > proto.FilePartMaxBytes+2 {
			return nil, invalid("a part is at most %d bytes", proto.FilePartMaxBytes)
		}
		data, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil {
			return nil, invalid("data isn't base64")
		}
		if len(data) > proto.FilePartMaxBytes {
			return nil, invalid("a part is at most %d bytes", proto.FilePartMaxBytes)
		}
		n, err := w.WriteFilePart(ctx, p, data)
		if err != nil {
			return nil, err
		}
		return map[string]int64{"size": n}, nil
	case proto.MethodFileComplete:
		if p.Size < 0 || !filePartSHA256.MatchString(p.SHA256) {
			return nil, invalid("sandbox.files.complete needs the file's size and its SHA-256 in lowercase hex")
		}
		if p.Mode > 0o777 {
			return nil, invalid("mode %o isn't a file's permissions", p.Mode)
		}
		size, mode, err := w.CompleteFileParts(ctx, p)
		if err != nil {
			return nil, err
		}
		return map[string]any{"size": size, "mode": fmt.Sprintf("%o", mode)}, nil
	default:
		return struct{}{}, w.AbortFileParts(ctx, p)
	}
}
