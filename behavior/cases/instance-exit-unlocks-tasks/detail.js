// Run through the guarded installed runner. Use the guest's English UI and
// neutral task titles/prompts so transcript text cannot supply the status.
function run([pid, title, action]) {
    const process = Application('System Events').applicationProcesses.whose({unixId: Number(pid)})[0];
    const window = process.windows[0];
    const controls = window.entireContents();
    const values = element => ['name', 'description', 'value'].map(key => {
        try {
            const value = element[key]();
            return typeof value === 'string' ? value : '';
        } catch { return ''; }
    });
    const rows = controls.map(element => ({element, role: element.role(), values: values(element)}));
    if (!rows.some(row => row.values.includes(title))) throw Error('Setup: select the exact task in ARC details');
    const label = 'instance-exit-unlocks-tasks/running-status-shown';
    const text = rows.flatMap(row => row.values).join(' ');
    if (!/window.{0,24}(closed|gone)|closed.{0,20}window/i.test(text) ||
        !/still running|continues? (to run|running)/i.test(text)) {
        throw Error(label + ': closed-window and ongoing-turn status must be visible');
    }
    const buttons = rows.filter(row => row.role === 'AXButton' &&
        row.values.some(value => /re[ -]?open/i.test(value)) && row.element.enabled());
    if (buttons.length !== 1) throw Error(label + ': expected one enabled Reopen action');
    if (action === 'reopen') buttons[0].element.actions.byName('AXPress').perform();
    return label + ' observed; ' + (action === 'reopen' ? 'Reopen pressed' : 'window left closed');
}
