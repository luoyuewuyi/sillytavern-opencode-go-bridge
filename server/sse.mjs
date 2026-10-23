// Turn a network read failure into a protocol error; cancellation still propagates.
export function guardedSseBody(body) {
    const reader = body.getReader();
    return new ReadableStream({
        async pull(controller) {
            try { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }
            catch { controller.enqueue(new TextEncoder().encode('\n\ndata: {"type":"error","error":{"code":"network_read_failed"}}\n\n')); controller.close(); }
        },
        cancel(reason) { return reader.cancel(reason); },
    });
}
// Preserve normal frames, including tool-call deltas and reasoning_content.
// Do not expose arbitrary provider error bodies; they can echo headers/prompts.
export function sanitizeSse(response) {
    const decoder = new TextDecoder(); const encoder = new TextEncoder();
    let buffer = ''; let done = false;
    const fail = controller => {
        controller.enqueue(encoder.encode('data: {"error":{"code":"go_stream_error","message":"Go 流式响应中断或返回错误；未重试或切换端点。"}}\n\ndata: [DONE]\n\n'));
        done = true; controller.terminate();
    };
    function frame(raw, controller) {
        const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
        if (data === '[DONE]') done = true;
        else if (data) {
            try { const value = JSON.parse(data); if (value.error || value.type === 'error') return fail(controller); }
            catch { return fail(controller); }
        }
        controller.enqueue(encoder.encode(raw));
        if (done) controller.terminate();
    }
    return new Response(guardedSseBody(response.body).pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (done) return;
            buffer += decoder.decode(chunk, { stream: true });
            let match;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const end = match.index + match[0].length;
                const raw = buffer.slice(0, end); buffer = buffer.slice(end);
                if (raw.length > 1024 * 1024) return fail(controller);
                frame(raw, controller);
                if (done) return;
            }
            if (buffer.length > 1024 * 1024) fail(controller);
        },
        flush(controller) {
            if (done) return;
            buffer += decoder.decode();
            if (buffer.trim()) frame(buffer, controller);
            if (!done) fail(controller);
        },
    })), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
