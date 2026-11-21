// kantel-isolate's guest: one classic script, evaluated once into the startup snapshot every isolate is made from
// (V8 can't deserialise isolates from two different snapshots in one process). It has all three runtimes; the host
// calls __kantel.init(kind) once per isolate, keeps the entry points it returns, and from then on the isolate's
// globals have no way to the host's ops: Deno, __bootstrap, __infra and __kantel are gone. The pieces are index.js
// (@kantel/isolate-guest); this is Kantel's own composition of them.
import { createGuest } from "./index.js";

globalThis.__kantel = createGuest();
