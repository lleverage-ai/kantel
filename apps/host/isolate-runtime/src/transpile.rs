//! Strip TypeScript types from a `.ts`/`.mts`/`.cts` the node runtime runs. Type stripping only (no down-levelling,
//! no decorators, no enums-as-values): the same thing Node's own --experimental-strip-types does, which is what
//! agents writing a quick `.ts` expect.

use anyhow::{Result, anyhow};
use deno_ast::{ModuleSpecifier, TypeStripOptions};

pub fn strip_types(filename: &str, code: String) -> Result<String> {
    let url = if filename.contains("://") {
        ModuleSpecifier::parse(filename)
    } else {
        ModuleSpecifier::parse(&format!("file://{}", if filename.starts_with('/') { filename.to_string() } else { format!("/{filename}") }))
    }
    .map_err(|e| anyhow!("bad specifier {filename}: {e}"))?;
    let module = Some(!filename.ends_with(".cts"));
    deno_ast::type_strip(&url, code, TypeStripOptions { module }).map_err(|e| anyhow!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_type_annotation() {
        let out = strip_types("x.ts", "const n: number = 1; console.log(n);".into()).unwrap();
        assert!(!out.contains(": number"));
        assert!(out.contains("const n"));
        assert!(out.contains("console.log(n)"));
    }

    #[test]
    fn keeps_runtime_code() {
        let out = strip_types("x.ts", "interface A { b: string }\nexport const f = (a: A): string => a.b;".into()).unwrap();
        assert!(!out.contains("interface"));
        assert!(out.contains("export const f"));
    }

    #[test]
    fn reports_a_syntax_error() {
        assert!(strip_types("x.ts", "const = ;".into()).is_err());
    }
}
