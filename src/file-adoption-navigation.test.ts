import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer = '';
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'trackFile') initializer = node.initializer!.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);

it('adds a new file without leaving the conversation and preserves scroll and focus', async () => {
  const state = { layout: 'conversation', view: 'funnel', selected: 'existing' };
  const button = { isConnected: false, focus: vi.fn() };
  const composer = { focus: vi.fn() };
  const scroller = { scrollTop: 240 };
  const documentDouble = { activeElement: button, querySelector: vi.fn((selector: string) => selector === '.chat-scroll' ? scroller : composer) };
  const deps = {
    work: { id: 'work', brandId: 'brand' }, document: documentDouble,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    run: (fn: () => Promise<void>) => fn(),
    api: { trackFile: vi.fn().mockResolvedValue({ id: 'new', title: 'Plan' }) },
    loadKnowledge: vi.fn().mockImplementation(async () => { scroller.scrollTop = 999; }),
    setNotice: vi.fn(), t: (_key: string, params: { name: string }) => `${params.name} added`,
    setLayout: (value: string) => { state.layout = value; }, setView: (value: string) => { state.view = value; },
    setSelectedDoc: (value: string) => { state.selected = value; },
  };
  expect(initializer).not.toBe('');
  const code = ts.transpileModule(`const handler = ${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const handler = new Function(...Object.keys(deps), `${code}; return handler;`)(...Object.values(deps));
  await handler('plan.md');
  expect(state).toEqual({ layout: 'conversation', view: 'funnel', selected: 'existing' });
  expect(scroller.scrollTop).toBe(240);
  expect(composer.focus).toHaveBeenCalledOnce();
  expect(deps.setNotice).toHaveBeenCalledWith('Plan added');
});

it('keeps review and document selection as explicit navigation actions', () => {
  expect(initializer).not.toContain('setLayout');
  expect(initializer).not.toContain('setView');
  expect(initializer).not.toContain('setSelectedDoc');
  expect(source).toContain("onClick={() => { setLayout('review'); setView('brief'); }}");
  expect(source).toContain("onSelect={id => brand && setSelectedDoc");
});
