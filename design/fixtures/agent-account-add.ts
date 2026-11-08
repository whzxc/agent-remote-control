export const accountAdd = {
  title: '添加 Codex 账号',
  methods: [{ value: 'oauth', label: 'CLI 登录' }, { value: 'import', label: '导入凭据' }],
  owners: [{ value: 'codex', label: '由 Codex 刷新' }, { value: 'none', label: '不自动刷新' }, { value: 'external', label: '外部托管' }],
  browser: '登录浏览器', browsers: [{ value: 'default', label: '系统默认浏览器' }],
  credentials: '凭据（auth.json）', credentialPlaceholder: '粘贴 auth.json 内容',
  refresh: '凭据刷新', program: '凭据更新程序', programPlaceholder: '本机可执行程序的绝对路径',
  args: '程序参数（JSON 数组）', argsPlaceholder: '["--account", "account-id"]',
  login: '开始登录', import: '导入', cancel: '取消',
};
