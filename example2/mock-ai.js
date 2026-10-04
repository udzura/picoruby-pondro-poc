// Offline demo only. The live configuration always uses the real AI binding.
export function createMockAI() {
  return {
    async run(model, input) {
      const system = input.messages.find(message => message.role === 'system')?.content ?? '';
      const latest = input.messages.at(-1)?.content ?? '';
      if (input.tools?.length) {
        if (input.messages.at(-1)?.role === 'tool') return { response: `[Mock agent] Tool result: ${latest}` };
        const match = latest.match(/remember ([^=\s]+)=(.*)/i);
        if (match) return { tool_calls: [{ name: 'remember', arguments: { key: match[1], value: match[2] } }] };
        const recall = latest.match(/recall (\S+)/i);
        if (recall) return { tool_calls: [{ name: 'recall', arguments: { key: recall[1] } }] };
        return { response: `[Mock agent] ${latest}. Try: remember color=blue / recall color` };
      }
      const response = `[Mock AI] ${system.split('\n')[0]}\nI heard: ${latest}`;
      const encoder = new TextEncoder();
      const frames = response.match(/[\s\S]{1,16}/gu).map(part => `data: ${JSON.stringify({ response: part })}\n\n`);
      frames.push('data: [DONE]\n\n');
      let index = 0;
      return new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 15));
          if (index >= frames.length) { controller.close(); return; }
          // Deliberately split a frame, including potentially inside UTF-8.
          const bytes = encoder.encode(frames[index++]);
          const middle = Math.floor(bytes.length / 2);
          controller.enqueue(bytes.slice(0, middle));
          controller.enqueue(bytes.slice(middle));
        }
      });
    }
  };
}
