/**
 * 流式 PCM16 切块不一定落在整采样上：奇数字节这样解码会抛错，这一块丢掉后，后面还全部错位成噪音。
 * 多出来的字节留到下一块开头。一路音频用一个，新的一轮要换新的。
 */
export function createPcm16Aligner(): (chunk: Uint8Array) => Uint8Array {
  let carry: number | null = null
  return (chunk) => {
    let joined = chunk
    if (carry !== null) {
      joined = new Uint8Array(chunk.length + 1)
      joined[0] = carry
      joined.set(chunk, 1)
    }
    const usable = joined.length - (joined.length % 2)
    carry = usable < joined.length ? joined[usable] : null
    return joined.subarray(0, usable)
  }
}
