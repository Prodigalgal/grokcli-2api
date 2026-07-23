export interface SseEvent {
  readonly data: string;
}

export async function* readSseEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseEvent> {
  if (!body) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      return null;
    }
    const event = { data: data.join("\n") };
    data = [];
    return event;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const next = buffer.indexOf("\n");
      if (next < 0) {
        break;
      }
      const line = buffer.slice(0, next).replace(/\r$/, "");
      buffer = buffer.slice(next + 1);
      if (line === "") {
        const event = flush();
        if (event) {
          yield event;
        }
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) {
    data.push(buffer.slice(5).trimStart());
  }
  const event = flush();
  if (event) {
    yield event;
  }
}
