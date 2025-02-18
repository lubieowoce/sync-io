use std::any::Any;
use std::io::Read;
use std::{mem, thread, time};

use napi::tokio;
use napi::tokio::runtime::Handle;
use napi::tokio::task;
use napi::CallContext;
use napi::JsObject;
/// import the preludes
use napi::{bindgen_prelude::*, JsUndefined};
use napi::{JsNumber, JsString, JsUnknown};
use napi_derive::napi;
use napi_derive::{js_function, module_exports};

// use napi::create_custom_tokio_runtime;
// use tokio::runtime::Builder;

// #[napi::module_init]
// fn init() {
//     let rt = Builder::new_current_thread()
//         .enable_all()
//         .thread_stack_size(32 * 1024 * 1024)
//         .build()
//         .unwrap();
//     //  let rt = Builder::new_multi_thread().enable_all().thread_stack_size(32 * 1024 * 1024).build().unwrap();
//     create_custom_tokio_runtime(rt);
// }

#[napi]
pub fn sleep_sync(duration: u32) {
    thread::sleep(time::Duration::from_millis(duration.into()));
}

// #[napi]
// pub fn await_sync(env: Env, arg: JsUnknown) -> Result<JsObject> {
//     let fut = Promise::<JsUnknown>::from_unknown(arg)?;
//     let res = env.spawn_future(fut)?;
//     Ok(res)
// }

#[module_exports]
fn init(mut exports: JsObject) -> Result<()> {
    println!("sync-io :: initializing napi");
    // exports.create_named_method("awaitSync", await_sync)?;
    Ok(())
}

#[napi]
pub fn get_example(env: Env) -> Result<String> {
    let mut res = reqwest::blocking::get("http://www.example.com")
        .map_err(|err| Error::from_reason(err.to_string()))?;
    let mut body = String::new();
    res.read_to_string(&mut body)?;
    Ok(body)
}

// struct Counter {
//     value: u64,
// }

// fn from_box(boxed: Box<Counter>) {

// }

// #[napi]
// pub fn create_counter() -> Result<u32> {
//     let counter = Box::new(Counter { value: 0 });
//     let addr = Box::into_raw(counter);
//     Ok(addr.addr() as u32)
// }

// #[js_function(1)]
// pub fn await_sync(ctx: CallContext) -> Result<()> {
//     // ctx.env.execute_tokio_future(fut, resolver)
//     // let event_loop = ctx.env.get_uv_event_loop().unwrap();
//     // event_loop.
//     // ctx.env.
//     let arg = ctx.get::<JsObject>(0)?;
//     if !&arg.is_promise()? {
//         return Err(Error::from_reason("Expected a promise"));
//     }
//     println!("{:?}", &arg.type_id());
//     Ok(())
// }

// #[napi]
// pub fn await_sync(env: Env, arg: Promise<String>) -> Result<JsString> {
//     // let fut = Promise::<JsUnknown>::from_unknown(arg)?;
//     let res = env.spawn_future(arg)?; // NOTE: this actually returns a js promise, so not what we want
//     res.coerce_to_string()
// }

#[napi]
pub fn await_sync(promise: Promise<String>) -> Result<String> {
    // TODO: i think this can't work, if we're blocking the thread, then i think the promise can never advance
    match tokio::runtime::Handle::try_current() {
        Err(_) => panic!("Could not get tokio runtime"),
        Ok(handle) => handle.block_on(promise),
    }
}

// #[napi]
// pub fn await_sync(promise: Promise<String>) -> Result<String> {
//     match tokio::runtime::Handle::try_current() {
//         Err(_) => panic!("Could not get tokio runtime"),
//         Ok(handle) => std::thread::spawn(move || {
//             // run async code in the new thread.
//             handle.block_on(promise)
//         })
//         .join()
//         .unwrap(),
//     }
// }
