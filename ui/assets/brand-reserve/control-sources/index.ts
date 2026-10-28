import { decorativeSvg } from '../decorative';
import { platformIcons, productIcons } from '../magpie';
import chatgpt from './chatgpt/mono.svg?raw';
import notion from './notion/mono.svg?raw';
import slack from './slack/color.svg?raw';
import github from './github/mono.svg?raw';
import grokBot from './grok-bot/app.png';

export const sourceImages: Record<string, string> = { 'grok-bot': grokBot };
export const sourceVectors: Record<string, string> = {
  ...Object.fromEntries(Object.entries({ chatgpt, notion, slack, github }).map(([id, svg]) => [id, decorativeSvg(svg)])),
  ...productIcons,
  ...platformIcons,
};
