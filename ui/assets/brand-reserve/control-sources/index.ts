import { decorativeSvg } from '../decorative';
// Control-source semantics; shared brand artwork can also be used by agents.
import chatgpt from './chatgpt/mono.svg?raw';
import notion from './notion/mono.svg?raw';
import slack from './slack/color.svg?raw';
import claude from '../agents/claude/color.svg?raw';
import microsoftCopilot from '../agents/copilot/color.svg?raw';
import cursor from '../agents/cursor/mono.svg?raw';
import githubCopilot from './github-copilot/mono.svg?raw';
import raycast from './raycast/mono.svg?raw';
import gemini from '../agents/gemini/color.svg?raw';
import grok from '../agents/grok/mono.svg?raw';
import anthropic from './anthropic/mono.svg?raw';
import microsoft from './microsoft/mono.svg?raw';
import github from './github/mono.svg?raw';
import google from './google/mono.svg?raw';
import xai from './xai/mono.svg?raw';
import grokBot from './grok-bot/app.png';
export const sourceImages: Record<string, string> = { 'grok-bot': grokBot };
export const sourceVectors: Record<string, string> = Object.fromEntries(Object.entries({
  chatgpt, notion, slack, claude, cursor, anthropic, microsoft, github, 'microsoft-copilot': microsoftCopilot,
  'github-copilot': githubCopilot, raycast: raycast.replace('<svg ', '<svg fill="currentColor" '), grok, gemini,
  google: google.replace('<svg ', '<svg fill="currentColor" '),
  xai: xai.replace('<svg ', '<svg fill="currentColor" '),
}).map(([name, svg]) => [name, decorativeSvg(svg)]));
