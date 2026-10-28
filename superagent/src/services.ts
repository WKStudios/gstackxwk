import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config';
import type { Store } from './store';
import type { Channel, ChannelName } from './channels/types';
import type { Delivery } from './delivery';
import type { Approvals } from './approvals';
import type { AgentRunner } from './agent/runner';
import type { BrowserClient } from './integrations/browser';
import type { MediaProviders } from './integrations/media';
import type { GoogleClient } from './integrations/google';
import type { NotionClient } from './integrations/notion';
import type { TwilioClient } from './integrations/twilio';
import type { SkillLibrary } from './skills';

/**
 * Hooks the router provides so background work can talk to a conversation
 * without racing an in-flight turn (history is strictly sequential).
 */
export interface ConversationHooks {
  /** Run the agent on an automated turn (e.g. background research finished). */
  enqueueTurn(conversationId: string, text: string): void;
  /** Append "[label] text" to history as something the agent already said. */
  appendNote(conversationId: string, label: string, text: string): void;
}

export interface JobRunner {
  runJobNow(jobId: string): Promise<{ status: string; output: string | null; error: string | null }>;
}

export interface Services {
  config: Config;
  store: Store;
  claude: Anthropic;
  channels: Map<ChannelName, Channel>;
  delivery: Delivery;
  approvals: Approvals;
  runner: AgentRunner;
  browser: BrowserClient;
  media: MediaProviders;
  skills: SkillLibrary;
  google?: GoogleClient;
  notion?: NotionClient;
  twilio?: TwilioClient;
  hooks: ConversationHooks;
  scheduler: JobRunner;
}
