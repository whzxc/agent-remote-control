import type { InlineName as InlineNameComponent } from '../components/composites/InlineName';
import type { ObjectMenu as ObjectMenuComponent } from '../components/composites/ObjectMenu';
import type { CopyValue as CopyValueComponent } from '../components/composites/CopyValue';
import type { ContextSettings as ContextSettingsComponent } from '../components/composites/ContextSettings';
import type { SrcConversationRow as SrcConversationRowComponent } from '../components/objects/src-conversation/Row';
import type { TaskChip as TaskChipComponent, TaskNode as TaskNodeComponent, TaskRow as TaskRowComponent, TaskCard as TaskCardComponent } from '../components/objects/task';
import type { AgentAccountCard as AgentAccountCardComponent } from '../components/objects/agent-account';
import type { AgentAccountRow as AgentAccountRowComponent } from '../components/objects/agent-account';
import type { AgentAccountNode as AgentAccountNodeComponent } from '../components/objects/agent-account';
import type { AgentAccountChip as AgentAccountChipComponent } from '../components/objects/agent-account';
import type { AgentPlatformCard as AgentPlatformCardComponent } from '../components/objects/agent-platform';
import type { AgentPlatformRow as AgentPlatformRowComponent } from '../components/objects/agent-platform';
import type { AgentPlatformNode as AgentPlatformNodeComponent } from '../components/objects/agent-platform';
import type { AgentPlatformChip as AgentPlatformChipComponent } from '../components/objects/agent-platform';
import type { RequestCard as RequestCardComponent } from '../components/composites/RequestCard';
import type { InteractionRequestCard as InteractionRequestCardComponent } from '../components/objects/interaction-request/Card';
import type { InteractionRequestChip as InteractionRequestChipComponent } from '../components/objects/interaction-request/Chip';
import type { InteractionRequestRow as InteractionRequestRowComponent } from '../components/objects/interaction-request/Row';
import type { AuthorizationRequestCard as AuthorizationRequestCardComponent } from '../components/objects/authorization-request/Card';
import type { AuthorizationRequestChip as AuthorizationRequestChipComponent } from '../components/objects/authorization-request/Chip';
import type { AuthorizationRequestRow as AuthorizationRequestRowComponent } from '../components/objects/authorization-request/Row';
import type { DeploymentProgressCard as DeploymentProgressCardComponent } from '../components/objects/deployment-progress/Card';
import type { DeploymentProgressChip as DeploymentProgressChipComponent } from '../components/objects/deployment-progress/Chip';
import type { SrcPlatformChip as SrcPlatformChipComponent, SrcPlatformNode as SrcPlatformNodeComponent, SrcPlatformRow as SrcPlatformRowComponent, SrcPlatformCard as SrcPlatformCardComponent } from '../components/objects/src-platform';
import type { SrcAccountChip as SrcAccountChipComponent, SrcAccountNode as SrcAccountNodeComponent, SrcAccountRow as SrcAccountRowComponent, SrcAccountCard as SrcAccountCardComponent } from '../components/objects/src-account';
import type { TunnelChip as TunnelChipComponent, TunnelNode as TunnelNodeComponent, TunnelRow as TunnelRowComponent, LocalConnectionRow as LocalConnectionRowComponent, TunnelCard as TunnelCardComponent } from '../components/objects/tunnel';
import { createContext, createElement, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { createRuntime } from 'virtual:arc-runtime';
import type { DispatchSpec as DispatchSpecComponent } from '../components/composites/DispatchSpec';
import type * as UI from '../components/ui';
import type AgentQuotaComponent from '../components/AgentQuota';
import type { AgentQuotaIcon as AgentQuotaIconComponent } from '../subscriptions/QuotaRing';
import type QuotaBubbleComponent from '../subscriptions/QuotaBubble';
import type GraphNodeComponent from '../components/GraphNode';
import type { ActivityBubble as ActivityBubbleComponent } from '../components/ActivityBubbles';
import type { Environment } from './environment';
import { fixtures } from './fixtures';
import { bubbleHeights, type BubbleDensity } from '../state/activityModel';

type Runtime = ReturnType<typeof createRuntime>;
const Context = createContext<{ runtime: Runtime; environment: Environment } | null>(null);
export type RootProps = Partial<Environment> & { children?: ReactNode };
export function Root({ mode = 'light', locale = 'en', privacy = false, now = fixtures.now, children }: RootProps) {
  if (!['light', 'dark'].includes(mode) || !['en', 'zh-CN'].includes(locale) || typeof privacy !== 'boolean' || !Number.isFinite(now)) {
    throw new Error('Arc.Root requires mode light/dark, locale en/zh-CN, boolean privacy and finite epoch milliseconds now.');
  }
  const environment = { mode, locale, privacy, now };
  const [runtime] = useState(() => {
    const instance = createRuntime();
    instance.configure(environment);
    return instance;
  });
  const node = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { runtime.configure(environment, node.current!); }, [runtime, mode, locale, privacy, now]);
  return createElement(Context.Provider, { value: { runtime, environment } },
    createElement('div', { ref: node, className: 'arc-root', 'data-theme': mode, 'data-theme-color': 'arc',
      'data-reduced-motion': 'true', lang: locale, style: { colorScheme: mode } }, children));
}

export type IconName = 'RefreshCw' | 'Plus' | 'Check' | 'X' | 'Info' | 'Plug' | 'Bot';
const iconNames: readonly string[] = ['RefreshCw', 'Plus', 'Check', 'X', 'Info', 'Plug', 'Bot'];
type TextProps<P> = Omit<P, 'children' | 'ref' | 'action' | 'icon' | 'dangerouslySetInnerHTML'> &
  (P extends { children: unknown } ? { children: string } : { children?: string });
type TextSlots<P, K extends keyof P> = Omit<{ [Key in keyof P]: Key extends K ? string : P[Key] }, 'ref' | 'dangerouslySetInnerHTML'>;
const textSlots: Record<string, readonly string[]> = {
  TaskRow: ['actions'], TaskCard: ['children'],
  AgentAccountCard: ["title", "icon", "headerActions", "titleActions", "secondary", "children", "footer", "danger"],
  AgentAccountRow: ["actions"],
  AgentPlatformCard: ["headerActions", "titleActions", "secondary", "children"],
  AgentPlatformRow: ["actions"],
  AgentPlatformNode: ["children"],
  RequestCard: ['title', 'context', 'leading', 'state', 'footer'],
  SrcAccountRow: ['actions'],
  SrcAccountCard: ['children', 'headerActions', 'footer', 'danger'],
  TunnelCard: ['headerActions'],
  SrcPlatformCard: ['headerActions'],
  SrcAccountNode: ['labelContent'],

  FunctionalPage: ['header'], SettingsSection: ['title', 'description'], SettingRow: ['label', 'description'],
  FormField: ['label', 'help'], FormSection: ['title', 'description'],
  Disclosure: ['title'], DangerZone: ['consequence'],
  PlatformIcon: ['quotaRing'],
  SectionHeader: ['title', 'leading', 'actions', 'back', 'close', 'widthControl', 'secondary', 'titleActions'],
  EntityRow: ['leading', 'title', 'secondary', 'state', 'actions'],
  EntityCard: ['icon', 'title', 'headerActions', 'footer', 'danger'],
  Freshness: ['age', 'unknown'], AddressField: ['display'],
};
function island<P extends object>(name: string) {
  function Island(props: P) {
    const context = useContext(Context);
    if (!context) throw new Error(`Arc.${name} requires an enclosing Arc.Root.`);
    const { runtime, environment } = context;
    const node = useRef<HTMLDivElement>(null);
    const mounted = useRef<ReturnType<Runtime['mount']> | null>(null);
    useLayoutEffect(() => {
      mounted.current = runtime.mount(node.current!, name);
      return () => { mounted.current?.unmount(); mounted.current = null; };
    }, [runtime]);
    useLayoutEffect(() => {
      const raw = props as Record<string, unknown>;
      const checkText = (value: unknown, key: string) => {
        if (value != null && typeof value !== 'string') throw new Error(`Arc.${name}.${key} accepts plain text only across React versions.`);
      };
      for (const key of ['children', 'action', ...(textSlots[name] ?? [])]) checkText(raw[key], key);
      if (raw.ref != null || raw.dangerouslySetInnerHTML != null) throw new Error(`Arc.${name} does not accept ref or dangerouslySetInnerHTML.`);
      if (raw.asChild || raw.titleAsChild) throw new Error(`Arc.${name} does not support asChild or titleAsChild across React versions.`);
      if (raw.titleProps != null) {
        const titleProps = raw.titleProps as Record<string, unknown>;
        if (titleProps.children != null || titleProps.ref != null || titleProps.dangerouslySetInnerHTML != null) {
          throw new Error(`Arc.${name}.titleProps accepts heading attributes only, without children, ref or dangerouslySetInnerHTML.`);
        }
      }
      const checkIcon = (value: unknown, key = 'icon') => {
        if (value != null && (typeof value !== 'string' || !iconNames.includes(value))) throw new Error(`Arc.${name}.${key} requires one of ${iconNames.join(', ')}.`);
      };
      if (name !== 'EntityCard') checkIcon(raw.icon);
      checkIcon(raw.fallback, 'fallback');
      if (name === 'StateBadge') checkIcon((raw.presentation as { icon?: unknown } | undefined)?.icon, 'presentation.icon');
      if (name === 'FactList') {
        for (const [index, item] of (raw.items as { label: unknown; value?: unknown }[]).entries()) {
          checkText(item.label, `items[${index}].label`);
          checkText(item.value, `items[${index}].value`);
        }
        if (raw.missing && 'placeholder' in (raw.missing as object)) checkText((raw.missing as { placeholder: unknown }).placeholder, 'missing.placeholder');
      }
      if (Array.isArray(raw.options)) for (const option of raw.options) {
        checkIcon(option.icon);
        if (option.content != null && typeof option.content !== 'string') throw new Error(`Arc.${name} option.content accepts plain text only.`);
        if (option.graphic != null && typeof option.graphic !== 'string') throw new Error(`Arc.${name} option.graphic accepts plain text only.`);
      }
      mounted.current!.update({ ...raw, ...((name === 'ActivityBubble' || name === 'TaskNode') ? { now: raw.now ?? environment.now } : {}) });
    });
    const density = (props as { density?: BubbleDensity }).density ?? 'standard';
    return createElement('div', { className: 'arc-island', ref: node, 'data-arc-component': name,
      style: (name === 'ActivityBubble' || name === 'TaskNode') ? { height: bubbleHeights[density] } : name === 'TunnelNode' ? { position: 'relative', height: (props as ComponentProps<typeof TunnelNodeComponent>).frame?.layout.height ?? 260, overflow: 'hidden' } : undefined });
  }
  Island.displayName = `Arc.${name}`;
  return Island;
}
export const Button = island<TextProps<ComponentProps<typeof UI.Button>>>('Button');
export const IconButton = island<Omit<ComponentProps<typeof UI.IconButton>, 'icon' | 'ref'> & { icon: IconName }>('IconButton');
export const Switch = island<ComponentProps<typeof UI.Switch>>('Switch');
type Choice = Omit<UI.Choice, 'icon' | 'graphic' | 'content'> & { icon?: IconName; graphic?: string; content?: string };
export const SingleChoice = island<Omit<ComponentProps<typeof UI.SingleChoice>, 'options'> & { options: readonly Choice[] }>('SingleChoice');
export const Notice = island<TextProps<ComponentProps<typeof UI.Notice>> & { action?: string }>('Notice');
export const Empty = island<TextProps<ComponentProps<typeof UI.Empty>> & { action?: string; icon?: IconName }>('Empty');
export const Loading = island<ComponentProps<typeof UI.Loading>>('Loading');
export const Status = island<TextProps<ComponentProps<typeof UI.Status>>>('Status');
export const Tag = island<TextProps<ComponentProps<typeof UI.Tag>>>('Tag');
export const AgentQuotaIcon = island<ComponentProps<typeof AgentQuotaIconComponent>>('AgentQuotaIcon');
export const AgentQuota = island<ComponentProps<typeof AgentQuotaComponent>>('AgentQuota');
export const QuotaBubble = island<ComponentProps<typeof QuotaBubbleComponent>>('QuotaBubble');
export const GraphNode = island<TextProps<ComponentProps<typeof GraphNodeComponent>>>('GraphNode');
export const ActivityBubble = island<Omit<ComponentProps<typeof ActivityBubbleComponent>, 'now'> & { now?: number }>('ActivityBubble');
export const PlatformIcon = island<Omit<TextSlots<ComponentProps<typeof UI.PlatformIcon>, 'quotaRing'>, 'fallback'> & { fallback?: IconName }>('PlatformIcon');
type BadgeProps = ComponentProps<typeof UI.StateBadge>;
export const StateBadge = island<Omit<BadgeProps, 'presentation'> & { presentation: Omit<BadgeProps['presentation'], 'icon'> & { icon: IconName } }>('StateBadge');
type HeaderProps = TextSlots<ComponentProps<typeof UI.SectionHeader>, 'children' | 'title' | 'leading' | 'actions' | 'back' | 'close' | 'widthControl' | 'secondary' | 'titleActions'>;
export const SectionHeader = island<Omit<HeaderProps, 'titleProps' | 'titleAsChild'> & {
  titleProps?: Omit<NonNullable<HeaderProps['titleProps']>, 'children' | 'dangerouslySetInnerHTML'>;
  titleAsChild?: false;
}>('SectionHeader');
export const EntityRow = island<TextSlots<ComponentProps<typeof UI.EntityRow>, 'children' | 'leading' | 'title' | 'secondary' | 'state' | 'actions'>>('EntityRow');
export const EntityCard = island<Omit<TextSlots<ComponentProps<typeof UI.EntityCard>, 'children' | 'icon' | 'title' | 'headerActions' | 'footer' | 'danger'>, 'asChild'> & { asChild?: false }>('EntityCard');
export const FactList = island<Omit<ComponentProps<typeof UI.FactList>, 'items' | 'missing'> & {
  items: readonly { label: string; value?: string | null; key?: string }[];
  missing: { omit: true } | { placeholder: string };
}>('FactList');
export const Freshness = island<TextSlots<ComponentProps<typeof UI.Freshness>, 'age' | 'unknown'>>('Freshness');
export const AddressField = island<TextSlots<ComponentProps<typeof UI.AddressField>, 'display'>>('AddressField');

export const FunctionalPage = island<TextSlots<ComponentProps<typeof UI.FunctionalPage>, 'header' | 'children'>>('FunctionalPage');
export const SettingsSection = island<TextSlots<ComponentProps<typeof UI.SettingsSection>, 'title' | 'description' | 'children'>>('SettingsSection');
export const SettingRow = island<TextSlots<ComponentProps<typeof UI.SettingRow>, 'label' | 'description' | 'children'>>('SettingRow');
export const FormField = island<TextSlots<ComponentProps<typeof UI.FormField>, 'label' | 'help' | 'children'>>('FormField');
export const FormSection = island<TextSlots<ComponentProps<typeof UI.FormSection>, 'title' | 'description' | 'children'>>('FormSection');
export const ActionGroup = island<TextProps<ComponentProps<typeof UI.ActionGroup>>>('ActionGroup');
export const Disclosure = island<TextSlots<ComponentProps<typeof UI.Disclosure>, 'title' | 'children'>>('Disclosure');
export const DangerZone = island<TextSlots<ComponentProps<typeof UI.DangerZone>, 'consequence' | 'children'>>('DangerZone');
export const DispatchSpec = island<ComponentProps<typeof DispatchSpecComponent>>('DispatchSpec');

export const ChoiceControl = island<Omit<ComponentProps<typeof UI.ChoiceControl>, 'options'> & { options: readonly Choice[] }>('ChoiceControl');

export const ViewStack = island<Omit<TextProps<ComponentProps<typeof UI.ViewStack>>, 'asChild'> & { asChild?: false }>('ViewStack');
export const MeterSegment = island<TextProps<ComponentProps<typeof UI.MeterSegment>>>('MeterSegment');

export const RequestCard = island<TextSlots<ComponentProps<typeof RequestCardComponent>, 'children' | 'context' | 'leading' | 'state' | 'footer'>>('RequestCard');

export const InteractionRequestCard = island<ComponentProps<typeof InteractionRequestCardComponent>>('InteractionRequestCard');

export const InteractionRequestChip = island<ComponentProps<typeof InteractionRequestChipComponent>>('InteractionRequestChip');

export const InteractionRequestRow = island<ComponentProps<typeof InteractionRequestRowComponent>>('InteractionRequestRow');

export const AuthorizationRequestCard = island<ComponentProps<typeof AuthorizationRequestCardComponent>>('AuthorizationRequestCard');

export const AuthorizationRequestChip = island<ComponentProps<typeof AuthorizationRequestChipComponent>>('AuthorizationRequestChip');

export const AuthorizationRequestRow = island<ComponentProps<typeof AuthorizationRequestRowComponent>>('AuthorizationRequestRow');

export const DeploymentProgressCard = island<ComponentProps<typeof DeploymentProgressCardComponent>>('DeploymentProgressCard');

export const DeploymentProgressChip = island<ComponentProps<typeof DeploymentProgressChipComponent>>('DeploymentProgressChip');


export const SrcPlatformChip = island<ComponentProps<typeof SrcPlatformChipComponent>>('SrcPlatformChip');

export const SrcPlatformNode = island<ComponentProps<typeof SrcPlatformNodeComponent>>('SrcPlatformNode');

export const SrcPlatformRow = island<ComponentProps<typeof SrcPlatformRowComponent>>('SrcPlatformRow');

export const SrcPlatformCard = island<TextSlots<ComponentProps<typeof SrcPlatformCardComponent>, 'headerActions'>>('SrcPlatformCard');

export const SrcAccountChip = island<ComponentProps<typeof SrcAccountChipComponent>>('SrcAccountChip');

export const SrcAccountNode = island<TextSlots<ComponentProps<typeof SrcAccountNodeComponent>, 'labelContent'>>('SrcAccountNode');

export const SrcAccountRow = island<TextSlots<ComponentProps<typeof SrcAccountRowComponent>, 'actions'>>('SrcAccountRow');

export const SrcAccountCard = island<TextSlots<ComponentProps<typeof SrcAccountCardComponent>, 'children' | 'headerActions' | 'footer' | 'danger'>>('SrcAccountCard');

export const TunnelChip = island<ComponentProps<typeof TunnelChipComponent>>('TunnelChip');

export const TunnelNode = island<Omit<ComponentProps<typeof TunnelNodeComponent>, 'svgRef'>>('TunnelNode');

export const TunnelRow = island<ComponentProps<typeof TunnelRowComponent>>('TunnelRow');

export const TunnelCard = island<TextSlots<ComponentProps<typeof TunnelCardComponent>, 'headerActions'>>('TunnelCard');

export const TaskChip = island<ComponentProps<typeof TaskChipComponent>>('TaskChip');
export const TaskNode = island<ComponentProps<typeof TaskNodeComponent>>('TaskNode');
type TaskRowMountProps<P> = P extends object ? Omit<P, 'actions'> & { actions?: string } : never;
export const TaskRow = island<TaskRowMountProps<ComponentProps<typeof TaskRowComponent>>>('TaskRow');
export const TaskCard = island<TextSlots<Omit<ComponentProps<typeof TaskCardComponent>, 'rootRef'>, 'children'>>('TaskCard');
export const AgentPlatformChip = island<ComponentProps<typeof AgentPlatformChipComponent>>('AgentPlatformChip');

export const AgentPlatformNode = island<TextSlots<ComponentProps<typeof AgentPlatformNodeComponent>, 'children'>>('AgentPlatformNode');

export const AgentPlatformRow = island<TextSlots<ComponentProps<typeof AgentPlatformRowComponent>, 'actions'>>('AgentPlatformRow');

export const AgentPlatformCard = island<TextSlots<ComponentProps<typeof AgentPlatformCardComponent>, 'headerActions' | 'titleActions' | 'secondary' | 'children'>>('AgentPlatformCard');

export const AgentAccountChip = island<ComponentProps<typeof AgentAccountChipComponent>>('AgentAccountChip');

export const AgentAccountNode = island<ComponentProps<typeof AgentAccountNodeComponent>>('AgentAccountNode');

export const AgentAccountRow = island<TextSlots<ComponentProps<typeof AgentAccountRowComponent>, 'actions'>>('AgentAccountRow');

export const AgentAccountCard = island<TextSlots<ComponentProps<typeof AgentAccountCardComponent>, 'title' | 'icon' | 'headerActions' | 'titleActions' | 'secondary' | 'children' | 'footer' | 'danger'>>('AgentAccountCard');

export const SrcConversationRow = island<ComponentProps<typeof SrcConversationRowComponent>>('SrcConversationRow');
export const LocalConnectionRow = island<ComponentProps<typeof LocalConnectionRowComponent>>('LocalConnectionRow');

export const InlineName = island<ComponentProps<typeof InlineNameComponent>>('InlineName');
export const ObjectMenu = island<ComponentProps<typeof ObjectMenuComponent>>('ObjectMenu');
export const CopyValue = island<ComponentProps<typeof CopyValueComponent>>('CopyValue');
export const ContextSettings = island<ComponentProps<typeof ContextSettingsComponent>>('ContextSettings');
