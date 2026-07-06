// Ponyfill for `Promise.withResolvers` (ES2024). The app's TS/build target
// is ES2022 and the native method only reached broad browser support in
// 2024, so this provides both the runtime shim (for older browsers still in
// the wild) and the ambient type declaration (so call sites get full type
// safety without bumping the project-wide `lib` target). Import this once
// for its side effect before any `Promise.withResolvers()` call site runs.
export {}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>
      resolve: (value: T | PromiseLike<T>) => void
      reject: (reason?: unknown) => void
    }
  }
}

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}
