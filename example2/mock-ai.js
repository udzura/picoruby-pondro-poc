// Offline demo only. The live configuration always uses the real AI binding.
export function createMockAI() {
  return {
    async run(model, input) {
      const system = input.messages.find(message => message.role === 'system')?.content ?? '';
      const latest = input.messages.at(-1)?.content ?? '';
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
