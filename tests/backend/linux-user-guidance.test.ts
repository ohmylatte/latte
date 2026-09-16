import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('Linux user guidance', () => {
  it('gives executable package commands with the published architecture names', () => {
    const runGuide = read('docs/RUN-linux.md');

    expect(runGuide).toContain('chmod +x ./Latte-<version>-linux-x86_64.AppImage');
    expect(runGuide).toContain('./Latte-<version>-linux-x86_64.AppImage');
    expect(runGuide).toContain('sudo apt install ./Latte-<version>-linux-amd64.deb');
    expect(runGuide).toContain('/opt/Latte/latte');
    expect(runGuide).toMatch(/<version>.*versi[oó]n/is);
    expect(runGuide).toMatch(/x86_64.*AppImage.*amd64.*\.deb/is);
  });

  it('limits Linux packaging claims in both languages to the verified environment', () => {
    const readme = read('README.md');
    const runGuide = read('docs/RUN-linux.md');

    expect(readme).toMatch(/Windows x64[^\n]*soportad[oa]/i);
    expect(readme).toMatch(/empaquetado (?:para|de) Linux x64[^\n]*alpha/i);
    expect(readme).toMatch(/Mint 22\.3[^\n]*X11/i);
    expect(readme).toMatch(/Wayland[^\n]*otras distribuciones[^\n]*no (?:fueron|est[aá]n).*verificad/i);
    expect(readme).toMatch(/Windows x64[^\n]*supported/i);
    expect(readme).toMatch(/Linux x64 packaging[^\n]*alpha/i);
    expect(readme).toMatch(/Wayland[^\n]*other distributions[^\n]*not yet verified/i);
    expect(runGuide).toMatch(/Mint 22\.3[^\n]*X11/i);
    expect(runGuide).toMatch(/Wayland[^\n]*otras distribuciones[^\n]*no (?:fueron|est[aá]n).*verificad/i);
    expect(readme).not.toMatch(/Windows x64 y Linux x64 est[aá]n soportados/i);
    expect(readme).not.toMatch(/supports Windows x64 and Linux x64/i);
  });

  it('uses PID-specific Linux recovery without changing Windows or macOS recovery', () => {
    const main = read('electron/main.ts');
    const readme = read('README.md');
    const combined = `${main}\n${readme}`;

    expect(combined).not.toMatch(/\bpkill\b/);
    expect(main).toContain("pgrep -af 'Latte|latte'");
    expect(main).toContain('kill <PID>');
    expect(main).toMatch(/empaquetad[oa].*(?:c[oó]digo|fuente)/i);
    expect(readme).toContain("pgrep -af 'Latte|latte'");
    expect(readme).toContain('kill <PID>');
    expect(readme).toMatch(/empaquetad[oa].*(?:c[oó]digo|fuente)/i);
    expect(main).toContain('[latte] Si no la ves, buscá el proceso Latte en el Monitor de Actividad y terminalo, y volvé a intentar.');
    expect(main).toContain('[latte] Si no la ves, cerrá el proceso electron.exe desde el Administrador de tareas y volvé a intentar.');
  });

  it('keeps verification wording current instead of a stale numeric snapshot', () => {
    const readme = read('README.md');

    expect(readme).not.toContain('not validated in this release');
    expect(readme).not.toMatch(/\| `npm test` \| \d+ tests pass/);
    expect(readme).toMatch(/\| `npm run build` \|[^\n]*validat/i);
    expect(readme).toMatch(/\| `npm test` \|[^\n]*(?:current|actual|suite|command)/i);
  });

  it('derives the current release version from package metadata', () => {
    const releasingGuide = read('docs/RELEASING.md');

    expect(releasingGuide).not.toMatch(
      /versión de trabajo actual es\s+(?:\*\*)?\d+\.\d+\.\d+/i,
    );
    expect(releasingGuide).toMatch(/versión de trabajo actual[^\n]*`package\.json`/i);
  });
});
