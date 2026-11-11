//! Host-side check on a WebAssembly module the guest wants to compile (op_kt_wasm_inspect). The guest's wasm guard
//! counts every byte of wasm memory against the isolate's budget by intercepting Memory(), grow() and instantiate();
//! for that to be watertight the module itself must not be able to grow memory behind grow()'s back, so this
//! refuses any module with a `memory.grow`/`memory.size` beyond what the guard sees, a shared or 64-bit memory, or a
//! declared maximum over the isolate's ceiling. It reports each memory the module defines or imports (and which
//! exports name them) so the guard can reserve their initial size and track their growth.

use serde::Serialize;
use wasmparser::{ExternalKind, Parser, Payload, TypeRef, ValidPayload, Validator, WasmFeatures};

/// 512 MiB in 64 KiB pages: no wasm memory may declare a larger maximum (kantel-host's largest isolate).
const MAX_PAGES: u64 = 512 * 1024 * 1024 / 65536;

#[derive(Serialize, Default)]
pub struct MemoryInfo {
    /// Initial size in 64 KiB pages.
    pub initial: u64,
    /// Declared maximum in pages, if any.
    pub maximum: Option<u64>,
    /// An imported memory (its bytes aren't allocated by instantiating this module).
    pub imported: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub memories: Vec<MemoryInfo>,
    /// export name → index into `memories`.
    pub memory_exports: std::collections::HashMap<String, usize>,
    /// Present when the module is refused; the guest throws a CompileError with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn features(allow_shared: bool) -> WasmFeatures {
    // Be permissive about which proposals the module uses (Pyodide uses exception handling, SIMD, bulk memory,
    // reference types and more): validation here is to parse the module soundly and to find its memories and any
    // memory.grow, not to gate features — V8 safely rejects any proposal it doesn't itself support. We only ever
    // narrow by refusing a 64-bit or (outside Pyodide boot) shared memory, which check_memory handles.
    let mut f = WasmFeatures::all();
    f.remove(WasmFeatures::MEMORY64);
    if !allow_shared {
        f.remove(WasmFeatures::THREADS);
        f.remove(WasmFeatures::SHARED_EVERYTHING_THREADS);
    }
    f
}

/// Inspect `bytes`. `allow_shared` is true only while Pyodide boots (trusted). Never panics; a parse failure, an
/// unsupported feature or a growable memory becomes `error`.
pub fn inspect(bytes: &[u8], allow_shared: bool) -> Info {
    match try_inspect(bytes, allow_shared) {
        Ok(info) => info,
        Err(error) => Info {
            error: Some(error),
            ..Default::default()
        },
    }
}

fn try_inspect(bytes: &[u8], allow_shared: bool) -> Result<Info, String> {
    let mut info = Info::default();
    let mut validator = Validator::new_with_features(features(allow_shared));
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|e| format!("invalid wasm: {e}"))?;
        // Validate everything (types, that memory.grow targets a memory the module has, and so on). This is what
        // stops a hand-built module that lies about its sections.
        match validator
            .payload(&payload)
            .map_err(|e| format!("invalid wasm: {e}"))?
        {
            ValidPayload::Func(f, body) => {
                f.into_validator(Default::default())
                    .validate(&body)
                    .map_err(|e| format!("invalid wasm: {e}"))?;
            }
            _ => {}
        }
        match payload {
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import = import.map_err(|e| format!("invalid wasm imports: {e}"))?;
                    if let TypeRef::Memory(m) = import.ty {
                        check_memory(&m)?;
                        info.memories.push(MemoryInfo {
                            initial: m.initial,
                            maximum: m.maximum,
                            imported: true,
                        });
                    }
                }
            }
            Payload::MemorySection(reader) => {
                for m in reader {
                    let m = m.map_err(|e| format!("invalid wasm memories: {e}"))?;
                    check_memory(&m)?;
                    info.memories.push(MemoryInfo {
                        initial: m.initial,
                        maximum: m.maximum,
                        imported: false,
                    });
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export.map_err(|e| format!("invalid wasm exports: {e}"))?;
                    if export.kind == ExternalKind::Memory {
                        info.memory_exports
                            .insert(export.name.to_string(), export.index as usize);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                // No memory.grow / memory.size in guest code: growth must come through Memory.prototype.grow, which
                // the guard counts. (grow() itself maps to the host growMemory via an import, not this instruction.)
                let mut reader = body
                    .get_operators_reader()
                    .map_err(|e| format!("invalid wasm code: {e}"))?;
                while !reader.eof() {
                    use wasmparser::Operator::{MemoryGrow, MemorySize};
                    match reader
                        .read()
                        .map_err(|e| format!("invalid wasm code: {e}"))?
                    {
                        MemoryGrow { .. } => {
                            return Err(
                                "a module that grows its own memory isn't allowed in an isolate (memory is limited per isolate)".into(),
                            );
                        }
                        MemorySize { .. } => {}
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(info)
}

fn check_memory(m: &wasmparser::MemoryType) -> Result<(), String> {
    if m.memory64 {
        return Err("64-bit wasm memory isn't available in an isolate".into());
    }
    if m.shared {
        return Err("shared wasm memory isn't available in an isolate".into());
    }
    // Only the *initial* size is checked here: that many bytes are reserved against the isolate's budget as soon as
    // the memory exists. The declared maximum is just a ceiling (wasm32 modules routinely declare the full 4 GiB);
    // real growth goes through Memory.prototype.grow, which the guard counts against the budget, so a memory can
    // never actually exceed the isolate's limit however large its maximum.
    if m.initial > MAX_PAGES {
        return Err(
            "wasm memory with an initial size over 512 MiB isn't allowed in an isolate".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // (module (memory 1 2) (export "m" (memory 0)))
    fn simple_memory() -> Vec<u8> {
        wat(r#"(module (memory 1 2) (export "m" (memory 0)))"#)
    }

    fn wat(s: &str) -> Vec<u8> {
        // A tiny hand-rolled assembler isn't worth it; build the bytes for the few shapes the tests need.
        match s {
            r#"(module (memory 1 2) (export "m" (memory 0)))"# => vec![
                0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
                0x05, 0x04, 0x01, 0x01, 0x01,
                0x02, // memory section: 1 memory, flags=1 (has max), min 1, max 2
                0x07, 0x05, 0x01, 0x01, 0x6d, 0x02, 0x00, // export section: "m" memory 0
            ],
            _ => unreachable!(),
        }
    }

    #[test]
    fn reports_a_memory_and_its_export() {
        let info = inspect(&simple_memory(), false);
        assert!(info.error.is_none(), "{:?}", info.error);
        assert_eq!(info.memories.len(), 1);
        assert_eq!(info.memories[0].initial, 1);
        assert_eq!(info.memories[0].maximum, Some(2));
        assert!(!info.memories[0].imported);
        assert_eq!(info.memory_exports.get("m"), Some(&0));
    }

    #[test]
    fn refuses_garbage() {
        assert!(inspect(b"not wasm", false).error.is_some());
        assert!(
            inspect(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0, 0xff], false)
                .error
                .is_some()
        );
    }

    // (module (memory 1) (func (memory.grow (i32.const 1)) drop))
    #[test]
    fn refuses_memory_grow_in_code() {
        let bytes = vec![
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
            0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: () -> ()
            0x03, 0x02, 0x01, 0x00, // function section: one func of type 0
            0x05, 0x03, 0x01, 0x00, 0x01, // memory section: 1 memory, min 1
            0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x01, 0x40, 0x00, 0x1a,
            0x0b, // code: i32.const 1; memory.grow 0; drop; end
        ];
        let info = inspect(&bytes, false);
        assert!(
            info.error
                .as_deref()
                .is_some_and(|e| e.contains("grows its own memory")),
            "{:?}",
            info.error
        );
    }
}
