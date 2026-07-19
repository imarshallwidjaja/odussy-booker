interface BodySource {
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export async function readBoundedText(response: BodySource, limit: number, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`${label} response exceeded the body limit`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error(`${label} response exceeded the body limit`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
