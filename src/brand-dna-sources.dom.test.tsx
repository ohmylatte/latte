import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrandDnaSourcesInput } from '../shared/contracts';
import { I18nProvider } from './i18n';
import { BrandDnaSources } from './BrandDnaSources';

/**
 * OTROS CANALES — la tarjeta que antes decía "Instagram".
 *
 * La marca publica donde ya publica: uno o varios links en un solo campo, y
 * cada uno con su plataforma al lado (reconocida por dominio, sin red). El
 * campo es de a uno por renglón o separados por coma; lo que Latte manda al
 * motor es la lista ya normalizada.
 */
afterEach(() => cleanup());

type MountProps = Partial<Parameters<typeof BrandDnaSources>[0]> & { onBuild?: (sources: BrandDnaSourcesInput) => void };

const mount = (props: MountProps = {}) => {
  const onBuild = props.onBuild ?? vi.fn();
  const view = render(
    <I18nProvider>
      <BrandDnaSources
        brandName="Ayulem"
        url=""
        name=""
        onName={vi.fn()}
        onUrl={vi.fn()}
        files={[]}
        onBuild={onBuild}
        {...props}
      />
    </I18nProvider>,
  );
  const field = () => screen.getByRole('textbox', { name: /canales/i }) as HTMLTextAreaElement;
  return { ...view, onBuild, field };
};

const type = (element: HTMLTextAreaElement, value: string) => {
  fireEvent.change(element, { target: { value } });
};

describe('Otros canales — la fuente dejan de ser Instagram', () => {
  it('la tarjeta se llama "Otros canales" y ofrece pegar links', () => {
    const { container, field } = mount();
    expect(screen.getByText('Otros canales')).toBeTruthy();
    expect(screen.queryByLabelText('Instagram')).toBeNull();
    const placeholder = field().placeholder;
    expect(placeholder).toContain('instagram.com/tumarca');
    expect(placeholder).toContain('linkedin.com/company/tumarca');
    expect(placeholder).toContain('Google Business');
    expect(container.textContent).toContain('Leemos lo público de cada canal.');
  });

  it('cada link reconocido muestra su plataforma al lado', () => {
    const { field } = mount();
    type(field(), 'instagram.com/ayulem, linkedin.com/company/ayulem\nhttps://youtube.com/@ayulem');
    const rows = [...document.querySelectorAll('.dna-channel-row')].map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Instagram');
    expect(rows[0]).toContain('instagram.com/ayulem');
    expect(rows[1]).toContain('LinkedIn');
    expect(rows[2]).toContain('YouTube');
  });

  it('lo que no es link ni @usuario queda a la vista, sin entrar en la lista', () => {
    const { field, onBuild } = mount();
    type(field(), 'instagram.com/ayulem\nhola mundo');
    expect([...document.querySelectorAll('.dna-channel-row')]).toHaveLength(1);
    expect(document.querySelector('.dna-channel-invalid')?.textContent).toContain('hola mundo');

    fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ }));
    expect(onBuild).toHaveBeenCalledWith({ url: null, channels: ['https://instagram.com/ayulem'], useIdentityFiles: false });
  });

  it('arma con lo que se pegó: un canal por entrada, ya normalizado', () => {
    const { field, onBuild } = mount();
    type(field(), 'instagram.com/ayulem\n@ayulem, https://x.com/ayulem');
    fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ }));
    expect(onBuild).toHaveBeenCalledWith({
      url: null,
      channels: ['https://instagram.com/ayulem', '@ayulem', 'https://x.com/ayulem'],
      useIdentityFiles: false,
    });
  });

  it('sin nada para leer no deja armar la marca', () => {
    const { onBuild } = mount();
    expect((screen.getByRole('button', { name: /Armar mi marca/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(onBuild).not.toHaveBeenCalled();
  });

  it('el recorrido inicial sigue pudiendo usar un solo canal en texto', () => {
    // OnboardingGate vive en otro worktree: esta tarjeta es la misma y sigue
    // aceptando el par `instagram`/`onInstagram` que hoy le pasa. El harness
    // hace lo mismo que el gate —guarda el texto en su estado—.
    const onInstagram = vi.fn();
    const onBuild = vi.fn();
    function Gate() {
      const [value, setValue] = useState('instagram.com/una-sola');
      return (
        <BrandDnaSources
          brandName="Ayulem"
          url=""
          instagram={value}
          onInstagram={(next) => { onInstagram(next); setValue(next); }}
          name=""
          onName={vi.fn()}
          onUrl={vi.fn()}
          files={[]}
          onBuild={onBuild}
        />
      );
    }
    render(<I18nProvider><Gate /></I18nProvider>);
    const field = screen.getByRole('textbox', { name: /canales/i }) as HTMLTextAreaElement;
    expect(field.value).toBe('instagram.com/una-sola');
    fireEvent.change(field, { target: { value: 'instagram.com/una-sola\nlinkedin.com/company/una-sola' } });
    expect(onInstagram).toHaveBeenCalledWith('instagram.com/una-sola\nlinkedin.com/company/una-sola');
    fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ }));
    expect(onBuild).toHaveBeenCalledWith({
      url: null,
      channels: ['https://instagram.com/una-sola', 'https://linkedin.com/company/una-sola'],
      useIdentityFiles: false,
    });
  });
});
