import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = '{{name}}';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: '{{toolName}}',
    description: 'Describe what the tool does so the model knows when to call it.',
    parameters: {
      input: { type: 'string', required: true, description: 'The text to process' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `{{toolName}} received: ${args.input}`;
    },
  }));
}
