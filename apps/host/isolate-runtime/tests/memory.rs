//! An isolate the embedder makes itself, held to one memory budget with the library's allocator: the same on the
//! stock V8 (a Rust allocator) and the sandboxed one (Kantel's in-sandbox allocator), where v8::new_rust_allocator
//! doesn't exist.

use std::time::Duration;

use deno_core::{JsRuntime, RuntimeOptions, v8};
use kantel_isolate::memory::{self, Budget};

fn run(rt: &mut JsRuntime, code: &'static str) -> Result<String, String> {
    let value = rt
        .execute_script("memory", code)
        .map_err(|e| e.to_string())?;
    deno_core::scope!(scope, rt);
    let local = v8::Local::new(scope, value);
    Ok(local.to_rust_string_lossy(scope))
}

#[test]
fn an_embedders_isolate_is_held_to_its_budget() {
    kantel_isolate::init_v8();
    // deno_core needs a tokio runtime around an isolate (V8 posts delayed tasks to it).
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = tokio.enter();
    let budget = Budget::new(64 << 20);
    let mut rt = JsRuntime::new(RuntimeOptions {
        create_params: Some(memory::create_params(&budget)),
        ..Default::default()
    });
    let mut watch = memory::watch(&mut rt, &budget);
    let running = memory::enforce(
        &mut rt,
        &budget,
        Duration::from_secs(10),
        Duration::from_secs(10),
    );

    // A buffer within the budget is allocated and counted against it.
    assert_eq!(
        run(
            &mut rt,
            "globalThis.kept = new ArrayBuffer(8 << 20); String(kept.byteLength)"
        )
        .unwrap(),
        (8 << 20).to_string()
    );
    assert!(
        budget.total() >= 8 << 20,
        "the buffer isn't counted: {}",
        budget.total()
    );

    // One past the budget isn't: a RangeError the program can catch, or the isolate stopped.
    let over = run(
        &mut rt,
        "try { new ArrayBuffer(100 << 20); 'allocated' } catch (e) { e.constructor.name }",
    );
    assert!(
        matches!(&over, Ok(name) if name == "RangeError") || over.is_err(),
        "{over:?}"
    );

    drop(running);
    rt.v8_isolate().cancel_terminate_execution();

    // The isolate is enforced as the runtime's are: a loop past its wall clock is stopped, with the reason. (A new
    // run starts with the last one's refusal cleared, as each of the runtime's commands does.)
    budget.reset_exceeded();
    let running = memory::enforce(
        &mut rt,
        &budget,
        Duration::from_secs(10),
        Duration::from_millis(200),
    );
    assert!(
        run(&mut rt, "for (;;) {}").is_err(),
        "the loop wasn't stopped"
    );
    assert_eq!(running.watched().term(), Some(memory::Term::Wall));
    drop(running);
    rt.v8_isolate().cancel_terminate_execution();
    watch.remove(&mut rt);
}
