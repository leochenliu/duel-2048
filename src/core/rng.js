// 确定性随机：整局可复现，是"同题异解"的地基
export function hashSeed(input) {
  const str = String(input)
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 稳定散列：用于共享事件流的就近落子排序，不消耗任何随机状态
export function hash2(a, b) {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35)) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0x27d4eb2f) >>> 0
  h ^= h >>> 15
  return h >>> 0
}
