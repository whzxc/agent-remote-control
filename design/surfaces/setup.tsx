import { Frame, Icon } from "sdg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { SingleChoice } from "../components/single-choice";
import { SetupAction } from "../components/setup-choice";
import { Field, Input } from "../components/field";
import { CopyField } from "../components/copy-field";
import { Tile } from "../components/tile";
import { type Brand } from "../components/agent-icon";
import ArcMark from "../art/setup-arc.svg";
import Gemini from "../art/gemini.svg";
import Grok from "../art/grok.svg";
import Copilot from "../art/microsoft-copilot.svg";
import GithubCopilot from "../art/github-copilot.svg";
import Qwen from "../art/qwen-code.svg";
import grokBot from "../art/grok-bot.png";
const productArt: Record<string, unknown> = {
  Gemini: <Gemini data-brand width={24} height={24} />,
  Grok: <Grok data-brand width={24} height={24} />,
  Copilot: <Copilot data-brand width={24} height={24} />,
  "GitHub Copilot": <GithubCopilot data-brand width={24} height={24} />,
  "Qwen Code": <Qwen data-brand width={24} height={24} />,
  "Grok Bot": <img src={grokBot} width={24} height={24} />,
};
const maskedAddress = "teatnsestonon.ssthssr.oshranr";
const methods = [
  {
    value: "relay",
    label: "创建我的中继",
    description: "推荐 · 部署到你的 Cloudflare 免费账号",
  },
  { value: "join", label: "粘贴中继链接", description: "粘贴中继邀请链接" },
  {
    value: "own",
    label: "使用自有地址",
    description: "已有域名、隧道或反向代理",
  },
];
const products = [
  ["ChatGPT", "openai"],
  ["Claude", "claude"],
  ["Gemini", "google"],
  ["Grok", "xai"],
  ["Copilot", "microsoft"],
  ["Notion", "notion"],
  ["Slack", "slack"],
  ["Cursor", "cursor"],
  ["GitHub Copilot", "microsoft"],
  ["Raycast", "raycast"],
  ["Codex", "codex"],
  ["Claude Code", "claude-code"],
  ["OpenCode", "opencode"],
  ["Qwen Code", "alibaba"],
  ["Grok Bot", "xai"],
].map(([label, brand]) => ({
  value: label,
  label,
  brand: brand as Brand,
  graphic: productArt[label],
  disabled: label === "Qwen Code",
  ...(label === "Qwen Code" ? { description: "不支持 oauth 认证" } : {}),
}));
const localProducts = [
  {
    value: "code",
    label: "Claude Code",
    brand: "claude-code" as Brand,
    disabled: true,
    description: "仅本机客户端可用",
  },
  {
    value: "desktop",
    label: "Claude 桌面版",
    brand: "claude" as Brand,
    disabled: true,
    description: "仅本机客户端可用",
  },
  {
    value: "other",
    label: "其他 MCP 客户端",
    graphic: <Icon name="plug" size={24} />,
  },
];
const welcomeOptions = [
  {
    icon: "monitor",
    title: "在这台电脑上",
    description: "Claude Code · Claude 桌面版",
    meta: "约 1 分钟 · 无需配置网络",
  },
  {
    icon: "smartphone",
    title: "在手机和网页上",
    description: "Claude · ChatGPT · Gemini · Grok",
    meta: "约 3 分钟 · 需要 Cloudflare 免费账号",
  },
];
type Step = {
  name: string;
  fixture: string;
  title?: string;
  labels?: string[];
  active?: number;
  subtitle?: string;
  done?: boolean;
  back?: string;
  action?: string;
  busy?: boolean;
  body: string;
};
const sourceLabels = ["平台 · Claude", "连接 · My relay", "配置", "批准"];
const connectionLabels = ["方式 · 创建我的中继", "配置", "就绪"];
const frames: Step[] = [
  { name: "welcome", fixture: "p3-welcome-light", body: "welcome" },
  {
    name: "source-product",
    fixture: "p3-source-fixed-light",
    title: "添加控制源",
    subtitle: "经由 My relay",
    labels: ["平台", "连接", "配置", "批准"],
    active: 0,
    action: "继续",
    body: "products",
  },
  {
    name: "source-connection",
    fixture: "p3-source-connection-light",
    title: "添加 Claude",
    labels: ["平台 · Claude", "连接", "配置", "批准"],
    active: 1,
    back: "返回",
    action: "继续",
    body: "connection",
  },
  {
    name: "source-empty",
    fixture: "p3-source-empty-light",
    title: "添加 Claude",
    labels: ["平台 · Claude", "连接", "配置", "批准"],
    active: 1,
    back: "返回",
    body: "empty",
  },
  {
    name: "source-local",
    fixture: "p3-source-local-light",
    title: "添加 Claude Code",
    labels: ["平台 · Claude Code", "连接 · Claude Code", "配置", "批准"],
    active: 2,
    back: "返回",
    action: "正在等待连接…",
    busy: true,
    body: "source-local",
  },
  {
    name: "source-address",
    fixture: "p3-source-address-light",
    title: "添加 Claude",
    labels: sourceLabels,
    active: 2,
    back: "返回",
    action: "等待 Claude 发起连接",
    busy: true,
    body: "address",
  },
  {
    name: "source-approval",
    fixture: "p3-source-approval-light",
    title: "添加 Claude",
    labels: sourceLabels,
    active: 3,
    back: "拒绝",
    action: "允许连接",
    body: "approval",
  },
  {
    name: "source-success",
    fixture: "p3-source-success-light",
    title: "添加 Claude",
    labels: sourceLabels,
    active: 3,
    done: true,
    action: "再添加一个",
    body: "success",
  },
  {
    name: "method",
    fixture: "p3-connection-method-light",
    labels: ["方式", "配置", "就绪"],
    active: 0,
    action: "登录 Cloudflare 并部署",
    body: "method",
  },
  {
    name: "stacked-method",
    fixture: "p3-stacked-method-light",
    labels: ["方式", "配置", "就绪"],
    active: 0,
    action: "登录 Cloudflare 并部署",
    body: "method",
  },
  {
    name: "stacked-relay",
    fixture: "p3-stacked-relay-light",
    labels: connectionLabels,
    active: 1,
    back: "取消",
    action: "进行中",
    busy: true,
    body: "relay",
  },
  {
    name: "stacked-local",
    fixture: "p3-stacked-local-light",
    labels: ["方式 · Claude Code", "配置", "就绪"],
    active: 1,
    back: "返回",
    action: "继续",
    body: "local",
  },
  {
    name: "stacked-join",
    fixture: "p3-stacked-join-light",
    labels: ["方式 · 粘贴中继链接", "配置", "就绪"],
    active: 1,
    back: "返回",
    action: "继续",
    body: "join",
  },
  {
    name: "stacked-own",
    fixture: "p3-stacked-own-light",
    labels: ["方式 · 使用自有地址", "配置", "就绪"],
    active: 1,
    back: "返回",
    action: "保存并启动",
    body: "own",
  },
  {
    name: "stacked-secure",
    fixture: "p3-stacked-secure-light",
    labels: ["方式 · OpenAI Secure Tunnel", "配置", "就绪"],
    active: 1,
    back: "返回",
    action: "保存并启动",
    body: "secure",
  },
  {
    name: "stacked-ready",
    fixture: "p3-stacked-ready-light",
    labels: connectionLabels,
    active: 2,
    done: true,
    action: "用这个连接继续",
    body: "ready",
  },
  {
    name: "ready",
    fixture: "p3-connection-ready-light",
    labels: connectionLabels,
    active: 2,
    done: true,
    action: "为它添加控制源",
    body: "ready",
  },
  {
    name: "relay-login",
    fixture: "p3-connection-login-dark",
    labels: connectionLabels,
    active: 1,
    back: "取消",
    action: "进行中",
    busy: true,
    body: "login",
  },
];
function ChoiceField({
  label,
  options,
  value,
  class: extra = "",
}: {
  label: string;
  options: string[];
  value: string;
  class?: string;
}) {
  return (
    <div class={`flex flex-col gap-3 ${extra}`}>
      <h3 class="text-small leading-4 font-semibold">{label}</h3>
      <SingleChoice
        label={label}
        value={value}
        options={options.map((label) => ({ value: label, label }))}
        fill
      />
    </div>
  );
}
function SetupField({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: string;
}) {
  return (
    <Field
      label={
        <span class="flex items-center gap-3">
          {label}
          {action && <span class="font-semibold">{action}</span>}
        </span>
      }
    >
      <Input value={value} />
    </Field>
  );
}
function Operations() {
  return (
    <div class="flex flex-col gap-[7px]">
      <ChoiceField
        label="操作列表（op）"
        options={["全部", "默认", "只读", "自定义"]}
        value="默认"
      />
      <div class="flex items-center gap-2">
        <p class="text-meta text-text-secondary">
          当前启用 1 组能力，共 3 个 op
        </p>
        <Button variant="ghost">查看全部</Button>
      </div>
    </div>
  );
}
function Welcome() {
  return (
    <Panel width={680} headerless>
      <div class="flex flex-col pt-[15px]">
        <div class="flex flex-col items-center gap-[21px]">
          <ArcMark data-brand width={64} height={64} />
          <h2 class="text-title leading-6 font-[650]">从哪里指挥 Codex？</h2>
        </div>
        <div class="mt-[39px] grid grid-cols-2 gap-4">
          {welcomeOptions.map((option) => (
            <div class="flex flex-col rounded-card bg-surface-subtle p-5">
              <Tile
                icon={option.icon}
                tone={option.icon === "monitor" ? "command" : "accent"}
              />
              <h3 class="mt-[17px] text-body leading-4 font-[650]">
                {option.title}
              </h3>
              <p class="mt-3 text-small leading-4 text-text-secondary">
                {option.description}
              </p>
              <p class="mt-[21px] text-meta leading-4 text-text-secondary">
                {option.meta}
              </p>
            </div>
          ))}
        </div>
        <div class="mt-9 flex items-center justify-between px-[22px]">
          <span class="flex items-center gap-3 text-small font-semibold">
            <span class="size-[6px] rounded-full bg-success" />
            Codex 已登录 · 权限已就绪
          </span>
          <Button variant="ghost" class="w-[222px]">
            有中继邀请链接？
          </Button>
        </div>
      </div>
    </Panel>
  );
}
function Body({ step }: { step: Step }) {
  const nested = step.name.startsWith("stacked-");
  switch (step.body) {
    case "products":
      return (
        <div class="flex flex-col gap-[10px]">
          <h3 class="text-meta leading-4 text-text-tertiary">远程连接</h3>
          <div class="pt-[2px]">
            <SingleChoice
              label="远程连接"
              value="Claude"
              options={products}
              form="setup-product"
              catalog
            />
          </div>
          <h3 class="text-meta leading-4 text-text-tertiary">这台电脑</h3>
          <div class="pt-[2px]">
            <SingleChoice
              label="这台电脑"
              value=""
              options={localProducts}
              form="setup-product"
              catalog
            />
          </div>
        </div>
      );
    case "connection":
      return (
        <div class="flex flex-col gap-4">
          <p class="text-body leading-4 text-text-secondary mb-1">
            Claude 通过哪个连接找到这台电脑？
          </p>
          <SingleChoice
            label="连接"
            value="relay"
            form="setup-row"
            options={[
              {
                value: "relay",
                label: "My relay",
                description: "中继链接 · 已承载 Claude · Personal · 在线",
              },
            ]}
          />
          <SetupAction
            icon="plus"
            label="添加连接"
            description="创建或加入中继，或使用自有地址，完成后回到这里"
          />
        </div>
      );
    case "empty":
      return (
        <div class="flex flex-col gap-3">
          <h3 class="text-body leading-4 font-[650]">还没有可用的连接</h3>
          <p class="text-body leading-4 text-text-secondary">
            Claude 通过哪个连接找到这台电脑？
          </p>
          <div class="grid grid-cols-3 gap-[10px] mt-2">
            {methods.map((method, i) => (
              <div>
                <SetupAction
                  catalog
                  icon={["cloud", "link", "plug"][i]}
                  label={method.label}
                  badge={i === 0 ? "推荐" : undefined}
                />
              </div>
            ))}
          </div>
        </div>
      );
    case "source-local":
      return <p class="text-body leading-6">安装后重启 Claude 即可</p>;
    case "local":
      return (
        <p class="text-body leading-6">
          为 Claude Code 安装本地连接配置，保留其他配置条目。
        </p>
      );
    case "address":
      return (
        <div class="flex flex-col gap-7">
          {["复制地址", "在 Claude 中添加", "点 Claude 里的“连接”"].map(
            (title, i) => (
              <section class="flex gap-[14px]">
                <span class="grid size-6 shrink-0 place-items-center rounded-control bg-surface-sunken text-meta font-semibold">
                  {i + 1}
                </span>
                <div
                  class={`flex flex-1 flex-col ${i === 0 ? "gap-3" : "gap-[6px]"}`}
                >
                  <h3 class="text-body leading-6 font-[650]">{title}</h3>
                  {i === 0 ? (
                    <div>
                      <CopyField value={maskedAddress} masked />
                    </div>
                  ) : i === 1 ? (
                    <div class="flex items-center gap-4">
                      <p class="text-small text-text-secondary">
                        设置 › 连接器 › 添加自定义连接器
                      </p>
                      <Button icon="external-link">打开 Claude 设置</Button>
                    </div>
                  ) : (
                    <p class="text-small leading-4 text-text-secondary">
                      浏览器会显示 4 位代码，这里会自动进入下一步。
                    </p>
                  )}
                </div>
              </section>
            ),
          )}
        </div>
      );
    case "approval":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex flex-col gap-6 rounded-card bg-surface-subtle px-5 py-[18px]">
            <div class="flex items-center gap-6">
              <strong class="font-mono text-[28px] leading-5">4F7K</strong>
              <p class="text-small">确认浏览器里显示的是同一个代码</p>
            </div>
            <p class="text-small leading-4 text-text-secondary">
              来源：Claude · 权限：此电脑已启用的全部操作
            </p>
          </div>
          <SingleChoice
            label="账号"
            value="new"
            fill
            options={[
              { value: "new", label: "作为新账号" },
              { value: "existing", label: "重新授权 Claude · Personal" },
            ]}
          />
          <SetupField label="这个账号叫什么" value="Claude" />
        </div>
      );
    case "success":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex items-center gap-4">
            <Tile icon="check" tone="success" />
            <div class="flex flex-col gap-[10px]">
              <h3 class="text-title leading-5 font-[650]">Claude 已连接</h3>
              <p class="text-meta leading-4 text-text-secondary">
                经由 My relay
              </p>
            </div>
          </div>
          <div class="flex flex-col gap-6">
            <p class="text-small leading-4 font-semibold">在 Claude 里试一句</p>
            <CopyField value="h Hssse heahttrrorstteah" masked />
          </div>
        </div>
      );
    case "method":
      return (
        <div class="flex flex-col gap-[38px]">
          <SingleChoice
            label="连接方式"
            value="relay"
            options={methods}
            form="setup-row"
          />
          {!nested && (
            <div class="grid grid-cols-[224px_186px_1fr] gap-4">
              {["OpenAI Secure Tunnel", "Claude Code", "Claude 桌面版"].map(
                (label, i) => (
                  <SingleChoice
                    label={label}
                    value=""
                    form="setup-row"
                    catalog
                    options={[{ value: label, label }]}
                  />
                ),
              )}
            </div>
          )}
        </div>
      );
    case "relay":
    case "login":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex flex-col gap-6">
            {["登录 Cloudflare", "部署中继", "连接这台电脑"].map((label, i) => (
              <div class="flex items-center gap-4">
                <Tile
                  icon={
                    i === 0
                      ? step.body === "login"
                        ? "loader-circle"
                        : "check"
                      : i === 1 && step.body === "relay"
                        ? "loader-circle"
                        : "circle"
                  }
                  tone={
                    i === 0 && step.body === "relay"
                      ? "success"
                      : i === 0 || (i === 1 && step.body === "relay")
                        ? "accent"
                        : "neutral"
                  }
                />
                <div class="flex flex-col gap-[10px]">
                  <h3 class="text-body leading-[14px] font-[650]">{label}</h3>
                  {((step.body === "login" && i < 2) ||
                    (step.body === "relay" && i === 1)) && (
                    <p class="text-meta leading-[14px] text-text-secondary">
                      {i === 0
                        ? "请在浏览器中完成授权"
                        : step.body === "login"
                          ? "大约 20 秒"
                          : "进行中 · 大约 20 秒"}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {step.body === "login" && (
            <Button variant="ghost">浏览器没打开？复制登录链接</Button>
          )}
        </div>
      );
    case "join":
      return (
        <div class="flex flex-col gap-6">
          <SetupField label="共享链接" value="" />
          <div class="flex flex-col gap-[6px]">
            <SetupField label="这台电脑的名称" value="Acceptance" />
            <p class="text-meta leading-4 text-text-secondary">
              托管者只能看到这个名称和在线时间。
            </p>
          </div>
        </div>
      );
    case "own":
      return (
        <div class="flex flex-col">
          <ChoiceField
            label="连接方式 · HTTPS MCP"
            options={[
              "ngrok",
              "Cloudflare",
              "Pinggy",
              "LocalXpose",
              "自定义域名",
            ]}
            value="Cloudflare"
            class="mb-[14px]"
          />
          <ChoiceField
            label="域名模式"
            options={["固定域名", "临时域名"]}
            value="固定域名"
            class="mb-[22px]"
          />
          <div class="grid grid-cols-2 gap-4 mb-4">
            <SetupField label="域名" value="mcp.example.com" />
            <SetupField label="连接名称" value="专用隧道" />
          </div>
          <SetupField
            label="Tunnel Token"
            value="粘贴 Cloudflare Tunnel Token"
            action="获取凭据"
          />
          <ChoiceField
            class="mt-4"
            label="身份认证"
            options={["无认证", "Bearer", "OAuth"]}
            value="OAuth"
          />
          <div class="mt-[26px]">
            <Operations />
          </div>
        </div>
      );
    case "secure":
      return (
        <div class="flex flex-col gap-6">
          {[
            { label: "Tunnel ID", value: "tunnel_…", action: "获取凭据" },
            {
              label: "Runtime API Key",
              value: "粘贴运行密钥",
              action: "获取 API Key",
            },
            { label: "连接名称", value: "OpenAI Secure Tunnel" },
          ].map((field) => (
            <SetupField {...field} />
          ))}
          <div>
            <Operations />
          </div>
        </div>
      );
    case "ready":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex items-center gap-4">
            <Tile icon="check" tone="success" />
            <h3 class="text-title leading-6 font-[650]">连接已添加</h3>
          </div>
          <div class="flex flex-col rounded-card bg-surface-subtle p-5">
            <h3 class="text-body leading-4 font-[650]">My relay</h3>
            <p class="mt-[10px] flex items-center gap-2 text-meta leading-4 text-text-secondary">
              <span class="size-[6px] rounded-full bg-success" />
              在线 · 1 个来源
            </p>
            <p class="mt-[18px] text-small leading-4 text-text-secondary">
              中继链接
            </p>
            <div class="mt-2">
              <CopyField value={maskedAddress} masked />
            </div>
          </div>
        </div>
      );
    default:
      return null;
  }
}
function Setup({ step }: { step: Step }) {
  if (step.body === "welcome") return <Welcome />;
  const nested = step.name.startsWith("stacked-");
  const subtitle = nested
    ? `完成后回到「添加 ${step.body === "secure" ? "ChatGPT" : "Claude"}」并自动选中`
    : step.subtitle;
  return (
    <Panel width={680} headerless>
      <div class="flex flex-col">
        <header class="flex h-(--control-height) items-center justify-between">
          <h2 class="text-title leading-6 font-[650]">
            {step.title || "添加连接"}
          </h2>
          <IconButton icon="x" label="关闭" />
        </header>
        {subtitle && (
          <p
            class={`mt-[6px] text-meta leading-4 ${nested ? "text-text-tertiary" : "text-text-secondary"}`}
          >
            {subtitle}
          </p>
        )}
        <ol class="mt-[15px] flex gap-3">
          {step.labels!.map((label, i) => (
            <li class="flex min-w-0 flex-1 flex-col gap-[6px]">
              <span
                class={`h-[3px] rounded-[2px] ${step.done ? "bg-success" : i <= step.active! ? "bg-accent" : "bg-surface-sunken"}`}
              />
              <span
                class={`text-meta leading-4 ${i === step.active ? "font-semibold text-text" : "text-text-secondary"}`}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>
        <div class="mt-[27px]">
          <Body step={step} />
        </div>
        <footer
          class={`mt-6 flex items-center gap-4 ${step.body === "approval" ? "justify-end" : "justify-between"}`}
        >
          {step.back ? (
            <Button
              variant={step.body === "approval" ? "secondary" : "ghost"}
              class={step.body === "approval" ? "min-w-[76px]" : "min-w-16"}
            >
              {step.back}
            </Button>
          ) : (
            <span />
          )}
          {step.action && (
            <Button
              variant="primary"
              busy={step.busy}
              disabled={step.body === "products"}
              icon={step.body === "method" ? "external-link" : undefined}
              class={`${step.busy ? "justify-start! " : ""}${step.body === "products" ? "opacity-45 " : ""}${step.body === "method" || step.body === "relay" ? "min-w-[216px]" : step.body === "ready" ? "min-w-[168px]" : step.body === "local" || step.body === "join" || step.body === "own" || step.body === "secure" ? "min-w-[120px]" : step.body === "source-local" ? "min-w-[176px]" : step.body === "address" ? "min-w-[200px]" : step.body === "approval" ? "min-w-[110px]" : step.body === "success" ? "min-w-[116px]" : step.action === "继续" ? "min-w-[76px]" : ""}`}
            >
              {step.action}
            </Button>
          )}
        </footer>
      </div>
    </Panel>
  );
}
export default () =>
  frames.map((step) => (
    <Frame
      name={step.name}
      fixture={step.fixture}
      capture={
        step.name.startsWith("stacked-")
          ? {
              selector: ".setup-dialog:has(.setup-return)",
              viewport: step.body === "own" ? "1280x1000" : "1280x800",
            }
          : {
              region:
                step.body === "welcome"
                  ? "从哪里指挥 Codex？"
                  : step.title || "添加连接",
              viewport: "1280x800",
            }
      }
      note={
        step.name.startsWith("stacked-")
          ? "Nested child shell. Width drift: asset 680px; implementation 680px × .92 rounds to 626px. Zero extracted texts in nested dialogs are an ARC accessibility defect."
          : undefined
      }
    >
      <Setup step={step} />
    </Frame>
  ));
