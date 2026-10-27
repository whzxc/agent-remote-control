// Preview recipes are required for every component value export in ui/design-mount.ts.
// Only Root accepts React elements; all island slots and children stay text-only.
export const previews = {
  InlineName: ['Composites', 160, "h(A.InlineName,{value:'Example team',revealed:true,onSave:async()=>{}})"],
  ObjectMenu: ['Composites', 260, "h(A.ObjectMenu,{label:'Account actions',revealed:true,items:[{label:'Remove',consequence:'Future work cannot use this account.',onSelect:async()=>{}}]})"],
  CopyValue: ['Composites', 160, "h(A.CopyValue,{value:'https://relay.example.com/mcp',onCopy:async()=>{}})"],
  ContextSettings: ['Composites', 260, "h(A.ContextSettings,{label:'Bubble width',revealed:true,value:'medium',options:['narrow','medium','wide'].map(value=>({value,label:value})),onChange:noop})"],
  SrcConversationRow: ['SRC', 260, "Col(...F.panels.conversations.map(conversation=>h(A.SrcConversationRow,{key:conversation.id,conversation,onTask:noop})))"],
  RequestCard: ['Composites', 340, "Col(h(A.RequestCard,{title:'Review verification',context:'Recorded request',pager:{index:0,count:2,onChange:noop},onClose:noop,footer:'Approve once'},'Run the selected project checks'),h(A.RequestCard,{title:'Response pending',busy:true,state:'Awaiting confirmation',error:'Synthetic response could not be confirmed',footer:'Retry'},'Retained request details'))"],
  InteractionRequestCard: ['Requests', 1040, 'h(InteractionDemo)'],
  InteractionRequestChip: ['Requests', 180, "Col(Row(h(A.InteractionRequestChip,{interaction:R.question,onOpen:noop,count:2}),h(A.InteractionRequestChip,{interaction:R.permission})),Row(...['submitting','unconfirmed','failed','submitted'].map(status=>h(A.InteractionRequestChip,{key:status,interaction:R.permission,submission:Submission(status,'allow'),onOpen:noop,disabled:status==='submitting'}))))"],
  InteractionRequestRow: ['Requests', 220, "Col(h(A.InteractionRequestRow,{entry:R.secretReceipt}),h(A.InteractionRequestRow,{entry:{...R.secretReceipt,id:'unresolved',status:'running',response:undefined,interaction:R.permission}}),h(A.InteractionRequestRow,{entry:{...R.secretReceipt,id:'external',response:undefined}}))"],
  AuthorizationRequestCard: ['Requests', 860, 'h(AuthorizationDemo)'],
  AuthorizationRequestChip: ['Requests', 140, "Row(...['pending','approved','denied','expired'].map(status=>h(A.AuthorizationRequestChip,{key:status,request:{...R.authorization,status},onOpen:status==='pending'?noop:undefined,disabled:status==='expired'})))"],
  AuthorizationRequestRow: ['Requests', 300, "Col(...['pending','approved','denied','expired'].map(status=>h(A.AuthorizationRequestRow,{key:status,request:{...R.authorization,status},source:F.sources[0],onOpen:noop,selected:status==='pending',disabled:status==='expired'})))"],
  DeploymentProgressCard: ['Requests', 900, 'h(DeploymentDemo)'],
  DeploymentProgressChip: ['Requests', 180, "Row(...['login','deploying','connecting','ready','failed'].map(phase=>h(A.DeploymentProgressChip,{key:phase,progress:{phase,action:'create'},onOpen:noop})),h(A.DeploymentProgressChip,{progress:{phase:'failed',action:'delete',cancelled:true},disabled:true,onOpen:noop}))"],
  TaskChip: ['TASK', 160, "Row(h(A.TaskChip,{task:{kind:'activity',session:T.session,live:true},onOpen:noop}),h(A.TaskChip,{task:{kind:'activity',session:{...T.session,endedAt:T.now,status:'completed'},live:false}}),h(A.TaskChip,{task:{kind:'receipt',record:{...T.receipt,state:'failed',error:'Synthetic dispatch failure'}},onOpen:noop,disabled:true}))"],
  TaskNode: ['TASK', 940, "Col(...['compact','standard','detailed'].map(density=>h(A.TaskNode,{key:density,agent:'claude',session:T.session,now:T.now,density,onOpen:noop,onRead:noop,selected:density==='standard'})),h(A.TaskNode,{agent:'claude',session:{...T.session,interaction:R.question},now:T.now,blocking:true,onOpen:noop,onRead:noop}),h(A.TaskNode,{agent:'claude',session:{...T.session,endedAt:T.now,status:'completed'},now:T.now,onOpen:noop,onRead:noop}))"],
  TaskRow: ['TASK', 740, "Col(h(A.TaskRow,{kind:'activity',agent:'claude',session:T.session,live:true,now:T.now,onOpen:noop,selected:true}),h(A.TaskRow,{kind:'activity',agent:'claude',session:{...T.session,source:'transcript',endedAt:T.now,status:'interrupted'},live:false,now:T.now,onOpen:noop}),h(A.TaskRow,{kind:'receipt',record:T.receipt,records:[T.receipt],id:T.receipt.requestId,onOpen:noop}),h(A.TaskRow,{kind:'dispatch',record:{...T.receipt,state:'failed',error:'Synthetic dispatch failure'},onOpen:noop}),h(A.TaskRow,{kind:'dispatch',record:T.receipt,onOpen:noop}))"],
  TaskCard: ['TASK', 680, "Col(h(A.TaskCard,{agent:'claude',task:{kind:'timeline',session:T.session,timeline:T.timeline,title:T.session.title,running:false,hasPending:false,source:T.session.dispatchSummary.controlSource,duration:'2m'},onBack:noop,onClose:noop,onOpen:noop,onToggleWidth:noop},T.session.headline),h(A.TaskCard,{agent:'codex',task:{kind:'receipt',record:T.receipt,records:[T.receipt]},narrow:true,busy:true,onOpen:noop,onClose:noop},T.receipt.task.prompt))"],
  AgentPlatformChip: ['AGENT', 140, "Row(h(A.AgentPlatformChip,{agent:G.agent,onOpen:noop,selected:true}),h(A.AgentPlatformChip,{agent:{...G.agent,enabled:false},disabled:true,onOpen:noop}),h(A.AgentPlatformChip,{agent:{...G.agent,installed:false,available:false,status:'not-installed'}}))"],
  AgentPlatformNode: ['AGENT', 160, "Row(h(A.AgentPlatformNode,{agent:G.agent,state:'normal',quota:G.account.quota,selected:true,onOpen:noop}),h(A.AgentPlatformNode,{agent:{...G.agent,enabled:false},state:'inactive',quota:null,onOpen:noop}))"],
  AgentPlatformRow: ['AGENT', 260, "Col(h(A.AgentPlatformRow,{agent:G.agent,onOpen:noop,selected:true}),h(A.AgentPlatformRow,{agent:{...G.agent,enabled:false},disabled:true,onOpen:noop}),h(A.AgentPlatformRow,{agent:{...G.agent,discoveryError:'Synthetic discovery failure'},onOpen:noop}))"],
  AgentPlatformCard: ['AGENT', 720, "Col(...['catalog','detail','panel'].map(frame=>h(A.AgentPlatformCard,{key:frame,agent:G.agent,frame,quota:G.account.quota,onOpen:noop,onLink:noop,headerActions:'Settings',loading:frame==='panel',error:frame==='panel'?'Synthetic read failure':undefined})))"],
  AgentAccountChip: ['AGENT', 160, "Row(h(A.AgentAccountChip,{account:G.account,agent:G.agent.agent,onOpen:noop,selected:true}),h(A.AgentAccountChip,{account:{...G.account,removedAt:new Date(F.now).toISOString()},agent:G.agent.agent,onOpen:noop}),h(A.AgentAccountChip,{account:{...G.account,agentProfiles:[]},agent:G.agent.agent}))"],
  AgentAccountNode: ['AGENT', 160, "Row(h(A.AgentAccountNode,{account:G.account,agent:G.agent.agent,state:'normal',selected:true,onOpen:noop}),h(A.AgentAccountNode,{account:{...G.account,quota:{state:'unavailable',windows:[]}},agent:G.agent.agent,state:'error',suffix:'Unavailable',onOpen:noop}))"],
  AgentAccountRow: ['AGENT', 280, "Col(h(A.AgentAccountRow,{account:G.account,agent:G.agent.agent,sources:[G.source],onOpen:noop,selected:true}),h(A.AgentAccountRow,{account:G.account,sources:[G.source],onOpen:noop}),h(A.AgentAccountRow,{account:{...G.account,removedAt:new Date(F.now).toISOString()},agent:G.agent.agent,onOpen:noop,disabled:true}))"],
  AgentAccountCard: ['AGENT', 980, "Col(h(A.AgentAccountCard,{account:G.account,agent:G.agent,frame:'panel',onReauth:noop,headerActions:'Refresh'}),h(A.AgentAccountCard,{account:G.account,agent:G.agent,loading:true,busy:true,error:'Synthetic read failure',onReauth:noop}))"],
  SrcPlatformChip: ['SRC', 120, "Row(h(A.SrcPlatformChip,{product:'claude',sources:F.sources,onOpen:noop}),h(A.SrcPlatformChip,{product:'unknown-product'}))"],
  SrcPlatformNode: ['SRC', 120, "Row(h(A.SrcPlatformNode,{product:'claude',state:'normal',selected:true,onOpen:noop}))"],
  SrcPlatformRow: ['SRC', 160, "Col(h(A.SrcPlatformRow,{product:'claude',onOpen:noop}),h(A.SrcPlatformRow,{product:'chatgpt',constraint:'Unavailable for this connection',disabled:true}))"],
  SrcPlatformCard: ['SRC', 640, "h(A.SrcPlatformCard,{product:'claude',sources:F.sources,accounts:F.accounts,ingresses:F.ingresses,onSource:noop,onConnection:noop,onAdd:noop,onLink:noop})"],
  SrcAccountChip: ['SRC', 120, "Row(h(A.SrcAccountChip,{source:F.sources[0],account:F.accounts[0],onOpen:noop}),h(A.SrcAccountChip,{provenance:{kind:'retired',label:'Historical source'}}))"],
  SrcAccountNode: ['SRC', 120, "h(A.SrcAccountNode,{product:'claude',account:F.accounts[0],state:'error',onOpen:noop})"],
  SrcAccountRow: ['SRC', 240, "Col(h(A.SrcAccountRow,{source:F.sources[0],account:F.accounts[0],ingress:F.ingresses[0],onOpen:noop,onConnection:noop}),h(A.SrcAccountRow,{source:{...F.sources[0],state:'revoked'},disabled:true}))"],
  SrcAccountCard: ['SRC', 400, "h(A.SrcAccountCard,{source:F.sources[0],account:F.accounts[0],ingress:F.ingresses[0],onConnection:noop})"],
  TunnelChip: ['TUNNEL', 120, "Row(h(A.TunnelChip,{ingress:F.ingresses[0],onOpen:noop}),h(A.TunnelChip,{missingName:'Removed connection'}))"],
  TunnelNode: ['TUNNEL', 560, "Col(Box(h(A.TunnelNode,{frame:F.tunnelFrames.landscape})),Box(h(A.TunnelNode,{frame:F.tunnelFrames.portrait})))"],
  LocalConnectionRow: ['TUNNEL', 160, "Col(h(A.LocalConnectionRow,{ingresses:[{...F.ingresses[0],transport:'local'}]}),h(A.LocalConnectionRow,{ingresses:[]}))"],
  TunnelRow: ['TUNNEL', 220, "Col(h(A.TunnelRow,{ingress:F.ingresses[0]}),h(A.TunnelRow,{ingress:{...F.ingresses[0],state:'error',error:'Synthetic failure'}}))"],
  TunnelCard: ['TUNNEL', 380, "h(A.TunnelCard,{ingress:F.ingresses[0]})"],
  Root: ['Foundation', 120, "Row(h(A.Status,{tone:'success'},F.labels.status),h(A.Button,{variant:'primary'},F.labels.button))"],
  FunctionalPage: ['Shells', 180, "h(A.FunctionalPage,{header:'Settings'},'Functional page content')"],
  ViewStack: ['Shells', 100, "h(A.ViewStack,{},'Retained panel content')"],
  MeterSegment: ['Primitives', 100, "Row(h(A.MeterSegment,{weight:3},'Used'),h(A.MeterSegment,{weight:1},'Remaining'))"],
  Button: ['Primitives', 140, "Row(...['primary','secondary','ghost','link','danger-outline','danger','surface'].map(variant=>h(A.Button,{key:variant,variant},variant)),h(A.Button,{busy:true},'Saving'),h(A.Button,{disabled:true},'Disabled'))"],
  IconButton: ['Primitives', 80, "Row(...['RefreshCw','Plus','Check','X'].map(icon=>h(A.IconButton,{key:icon,icon,label:icon})),h(A.IconButton,{icon:'RefreshCw',label:'Refreshing',busy:true}),h(A.IconButton,{icon:'Plus',label:'Disabled',disabled:true}))"],
  Switch: ['Primitives', 110, 'h(SwitchDemo)'],
  SingleChoice: ['Primitives', 110, 'h(ChoiceDemo)'],
  ChoiceControl: ['Forms', 120, "Col(h(A.ChoiceControl,{label:'Release channel',value:'stable',options:[{value:'stable',label:'Stable'}],onChange:noop}),h(A.ChoiceControl,{label:'Empty choices',value:'',options:[],onChange:noop}))"],
  Notice: ['Primitives', 220, "Col(h(A.Notice,{tone:'danger'},F.labels.notice),h(A.Notice,{tone:'warning'},'Reauthorization required'),h(A.Notice,{tone:'success'},'Connection added'))"],
  Empty: ['Primitives', 160, "h(A.Empty,{icon:'Info'},F.labels.empty)"],
  Loading: ['Primitives', 80, 'h(A.Loading)'],
  Status: ['Primitives', 80, "Row(h(A.Status,{},'Idle'),h(A.Status,{tone:'success'},F.labels.status),h(A.Status,{tone:'warning'},'Needs sign-in'),h(A.Status,{tone:'danger'},'Failed'))"],
  Tag: ['Primitives', 80, "Row(h(A.Tag,{},F.labels.tag),h(A.Tag,{tone:'source'},'SRC'),h(A.Tag,{tone:'agent'},'AGENT'))"],
  AgentQuotaIcon: ['Quota', 100, "Row(h(A.AgentQuotaIcon,{agent:'codex'}),h(A.AgentQuotaIcon,{agent:'claude',dual:true,quota:F.accounts[0].quota}),h(A.AgentQuotaIcon,{agent:'dsh',quota:null}))"],
  AgentQuota: ['Quota', 480, "Col(...['ready','refreshing','empty'].map(state=>Box(h(A.AgentQuota,{provider:F.quotaStates[state],refreshing:state==='refreshing',onRefresh:noop}))))"],
  QuotaBubble: ['Quota', 640, "Col(...['ready','unavailable'].map(state=>Box(h(A.QuotaBubble,{provider:F.quotaStates[state],link:false,onRefresh:async()=>{}}))))"],
  GraphNode: ['Topology', 120, "Row(...['normal','connecting','error','inactive'].map((state,i)=>h(A.GraphNode,{key:state,label:F.sources[i%F.sources.length].label+': '+state,state,onOpen:noop},state)),h(A.GraphNode,{label:'Highlighted',state:'normal',highlighted:true,onOpen:noop},'Selected'))"],
  ActivityBubble: ['Topology', 520, "Col(...['compact','standard','detailed'].map((density,i)=>Box(h(A.ActivityBubble,{agent:F.activitySessions[i].agent,session:F.activitySessions[i],density,onRead:noop}))))"],
  PlatformIcon: ['Shells', 100, "Row(...['source','agent','provider'].map(role=>h(A.PlatformIcon,{key:role,platform:role==='source'?F.sources[0].product:'claude',role,size:28})),h(A.PlatformIcon,{platform:'unknown',role:'provider',fallback:'Info',size:28}),h(A.PlatformIcon,{platform:'codex',role:'agent',add:true,size:28}))"],
  StateBadge: ['Shells', 160, "Col(...['badge','dot','compact','text'].map(variant=>Row(...['accent','success','warning','danger','neutral'].map(tone=>h(A.StateBadge,{key:tone,variant,presentation:{tone,labelKey:'connected',icon:'Check'},label:tone})))))"],
  SectionHeader: ['Shells', 180, "Col(h(A.SectionHeader,{title:'Providers',level:2,count:F.quotaSnapshots.length,leading:'P',secondary:'Quota',actions:'Refresh'}),h(A.SectionHeader,{title:'Accounts',level:3,count:0,back:'Back'}))"],
  EntityRow: ['Shells', 220, "Col(h(A.EntityRow,{title:F.sources[0].label,secondary:'Control source',state:'Ready'}),h(A.EntityRow,{title:F.agents[0].agent,secondary:'Agent',selected:true,attention:true,chevron:true,onClick:noop}),h(A.EntityRow,{title:'Unavailable',disabled:true,chevron:true,href:'#root'}))"],
  EntityCard: ['Shells', 280, "Col(h(A.EntityCard,{icon:'C',title:F.quotaSnapshots[0].name,headerActions:'Refresh',footer:'Observed now',danger:'Unavailable'},'Provider details'),h(A.EntityCard,{variant:'outline'},'Untitled content'))"],
  FactList: ['Shells', 220, "Col(...[{placeholder:'Unknown'},{omit:true}].map(missing=>h(A.FactList,{items:[{label:'Agent',value:F.agents[0].agent},{label:'Plan'}],missing})))"],
  Freshness: ['Shells', 160, "Col(h(A.Freshness,{observedAt:new Date(F.now).toISOString(),age:'Just now',onRefresh:noop}),h(A.Freshness,{observedAt:F.quotaStates.stale.observedAt,age:'Two hours ago',stale:true,onRefresh:noop}),h(A.Freshness,{observedAt:null,age:'',unknown:'Unknown',busy:true,onRefresh:noop}))"],
  AddressField: ['Shells', 260, 'h(AddressDemo)'],
  SettingsSection: ['Forms', 160, "h(A.SettingsSection,{title:'App updates',description:'Current version'},'Agent Remote Control v1.0.0')"],
  SettingRow: ['Forms', 220, "Col(h(A.SettingRow,{label:'Release channel'},'Stable'),h(A.SettingRow,{label:'Current version',description:'Agent Remote Control v1.0.0',onNavigate:noop}),h(A.SettingRow,{label:'Unavailable',onNavigate:noop,disabled:true}))"],
  FormField: ['Forms', 180, "Col(h(A.FormField,{label:'Label',help:'Maximum 120 bytes.'},'Example source'),h(A.FormField,{label:'Invalid value',error:'Enter a value.'},'Unavailable'))"],
  FormSection: ['Forms', 140, "h(A.FormSection,{title:'Connection'},'Connection fields')"],
  ActionGroup: ['Forms', 140, "Col(h(A.ActionGroup,{align:'leading'},'Leading actions'),h(A.ActionGroup,{},'Trailing actions'))"],
  Disclosure: ['Forms', 180, "Col(h(A.Disclosure,{title:'Advanced',defaultOpen:true},'Advanced settings'),h(A.Disclosure,{title:'Collapsed'},'Additional settings'))"],
  DangerZone: ['Forms', 140, "h(A.DangerZone,{consequence:'Disconnecting removes source access.'},'Disconnect')"],
  DispatchSpec: ['Composites', 380, "Col(...F.dispatchSpecs.map(spec=>h(A.DispatchSpec,{key:spec.label,...spec})))"],
};

const prelude = `const h=React.createElement, A=window.Arc, F=A.fixtures;
const R=F.requests, T=F.tasks, G=F.agentObjects;
const mode=document.documentElement.dataset.theme==='dark'?'dark':'light';
const noop=()=>{};
const Row=(...children)=>h('div',{style:{display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap'}},...children);
const Col=(...children)=>h('div',{style:{display:'flex',flexDirection:'column',gap:'12px'}},...children);
const Box=child=>h('div',{style:{width:'380px',maxWidth:'100%'}},child);
const Submission=(status,decision='answer')=>({status,decision,payload:{op:'codex_respond',args:{}},...(status==='failed'?{error:'Synthetic response failure'}:{})});
function InteractionDemo(){const[answers,onAnswersChange]=React.useState({});const[index,onChange]=React.useState(0);const props={answers,onAnswersChange,onRespond:noop};return Col(h(A.InteractionRequestCard,{...props,interaction:index?R.permission:R.question,pager:{index,count:2,onChange}}),...['submitting','unconfirmed','failed'].map(status=>h(A.InteractionRequestCard,{...props,key:status,interaction:R.permission,submission:Submission(status,'allow')})));}
function AuthorizationDemo(){const[sourceId,onSourceChange]=React.useState('new');const[label,onLabelChange]=React.useState('Design source');const props={request:R.authorization,ingress:F.ingresses[0],sourceId,onSourceChange,label,onLabelChange,candidates:F.sources,remaining:[],onDecide:noop};return Col(h(A.AuthorizationRequestCard,props),h(A.AuthorizationRequestCard,{...props,request:{...R.authorization,switchSourceId:G.source.id},fixed:G.source,oldConnection:G.ingress,remaining:[G.source],busy:true,error:'Synthetic authorization failure'}),h(A.AuthorizationRequestCard,{...props,request:{...R.authorization,status:'denied'}}));}
function DeploymentDemo(){const[account,setAccount]=React.useState('');const props={account,setAccount,busy:false,onCancel:noop,onRetry:noop};return Col(h(A.DeploymentProgressCard,{...props,progress:R.deployment}),h(A.DeploymentProgressCard,{...props,progress:{phase:'connecting',action:'create'}}),h(A.DeploymentProgressCard,{...props,progress:{phase:'ready',action:'create',result:{url:'https://relay.example.com'}}}),h(A.DeploymentProgressCard,{...props,busy:true,progress:{phase:'failed',action:'delete',cancelled:true}}));}
function SwitchDemo(){const[checked,setChecked]=React.useState(true);return Col(h(A.Switch,{checked,onChange:setChecked,label:'Open tasks in Codex'}),h(A.Switch,{checked:false,onChange:noop,label:'Disabled',disabled:true}));}
function ChoiceDemo(){const[value,onChange]=React.useState(F.choices[0].value);return Col(h(A.SingleChoice,{label:'Agent',value,options:F.choices,onChange}),h(A.SingleChoice,{label:'Disabled agent',value,options:F.choices,onChange,disabled:true}));}
function AddressDemo(){const[revealed,setRevealed]=React.useState(false);const[copied,setCopied]=React.useState(false);const value='https://example.com';return Col(h(A.AddressField,{label:'Provider address',value,display:revealed?value:'••••',revealed,onReveal:()=>setRevealed(v=>!v),copied,onCopy:()=>setCopied(true)}),h(A.AddressField,{label:'Disabled address',value,display:value,disabled:true,onCopy:noop}),h(A.AddressField,{label:'Empty address',value:'',display:'',placeholder:'No address',error:'Address unavailable',onCopy:noop}));}
`;

export function previewHtml(name) {
  const [group, height, body] = previews[name];
  return `<!-- @dsCard group="${group}" height=${height} -->
<div id="root" style="padding:16px;box-sizing:border-box"></div>
<script>
${prelude}ReactDOM.createRoot(document.getElementById('root')).render(h(A.Root,{mode,now:${['Requests', 'Relay', 'TASK'].includes(group) ? 'R.now' : 'F.now'},privacy:false},${body}));
</script>
`;
}
