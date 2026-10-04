// 内存版 localStorage，让纯前端数据层可以在 Node 中跑通端到端核实。
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
}
await import('../verify-chain.bundle.mjs')
