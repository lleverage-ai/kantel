# Load test: long sessions side by side in the stack object

One stack object (`KantelStack`, `m1`) hosts every session in one isolate with Cloudflare's 128 MB limit. These scripts
run long sessions at once under `wrangler dev` with no model spend, and say what holds the isolate's memory.

1. The scripted model, a CPA stand-in that answers every call from its request (`model.ts`):

   ```bash
   node scripts/load/model.ts 8798
   ```

2. `wrangler dev` with its model calls sent there, and the inspector open:

   ```bash
   KANTEL_DEV_MODELS_URL=http://localhost:8798 npx wrangler dev --env dev --port 8799 --inspector-port 9339
   ```

   (Put `KANTEL_DEV_MODELS_URL` in `.dev.vars`, or pass it with `--var`.)

3. The sessions (`run.ts`). A prompt `load steps=<n> out=<bytes> write=<bytes> container=<bytes> text=<bytes>` makes the
   scripted model run `n` tool calls in turn: a `bash` printing `out` bytes, a `write` of `write` bytes, a `read` of it,
   and (with the container tier) a `bash` in the container writing `container` bytes, staged back by its checkpoint.

   ```bash
   node scripts/load/run.ts --sessions 3 --turns 4 \
     --prompt "load steps=16 out=400000 write=300000 text=8000" --stage-bytes 3000000 \
     --inspector ws://localhost:9339/ws --out results.json [--cold-creates 20] [--close]
   ```

   It prints each turn's time, every 5xx (a reset reaches a client as a 503) and the heap sampled through the inspector.
   The sampled peak includes garbage not yet collected; compare live sets with `heap.ts`.

4. What holds the memory (`heap.ts`), after a full collection:

   ```bash
   node scripts/load/heap.ts usage
   node scripts/load/heap.ts snapshot after.heapsnapshot
   node scripts/load/heap.ts summary after.heapsnapshot
   ```

`wrangler dev` doesn't enforce the 128 MB limit, so a run here measures memory; resets are counted on the deployed stack
(Workers Observability, `durableObjectReset`, one per reset rather than one per request in flight).
