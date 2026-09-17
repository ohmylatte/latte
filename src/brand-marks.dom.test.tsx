import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ApprovalStamp, CupFromAbove, LMark, Loading, roleColorVar, SteamWisp, VersionRing } from './brand-marks';

describe('brand marks', () => {
  it('SteamWisp draws a single stroked path', () => {
    const { container } = render(<SteamWisp className="team-steam" />);
    const svg = container.querySelector('svg.team-steam');
    expect(svg).not.toBeNull();
    const path = svg!.querySelector('path');
    expect(path).not.toBeNull();
    expect(path!.getAttribute('stroke')).toBe('currentColor');
    expect(path!.getAttribute('fill')).toBe('none');
  });

  it('LMark draws the L polygon', () => {
    const { container } = render(<LMark size={34} />);
    const poly = container.querySelector('polygon');
    expect(poly).not.toBeNull();
    expect(poly!.getAttribute('points')).toContain('56,96');
  });

  it('CupFromAbove draws a rim and a coffee circle scaled to the level', () => {
    const { container } = render(<CupFromAbove size={32} level={0.5} />);
    const circles = [...container.querySelectorAll('circle')];
    expect(circles).toHaveLength(2);
    const rim = circles[0];
    const coffee = circles[1];
    expect(rim.getAttribute('fill')).toBe('none');
    expect(coffee.getAttribute('fill')).toBe('var(--rust)');
    // level 0.5 of r=45 -> 22.5
    expect(Number(coffee.getAttribute('r'))).toBeCloseTo(22.5);
  });

  it('roleColorVar maps known roles to their token and falls back to default', () => {
    expect(roleColorVar('strategist')).toBe('var(--role-strategist)');
    expect(roleColorVar('reviewer')).toBe('var(--role-reviewer)');
    expect(roleColorVar('some-unknown-role')).toBe('var(--role-default)');
  });

  it('Loading announces itself and fills the cup', () => {
    const { container } = render(<Loading size={32} label="Abriendo el trabajo" />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute('aria-label')).toBe('Abriendo el trabajo');
    expect(container.querySelector('.loading-cup-coffee')).not.toBeNull();
  });

  it('ApprovalStamp draws the rim, the coffee and the L in foam', () => {
    const { container } = render(<ApprovalStamp size={34} className="approval-stamp" />);
    const svg = container.querySelector('svg.approval-stamp');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('circle')).toHaveLength(2);
    const poly = svg!.querySelector('polygon');
    expect(poly).not.toBeNull();
    expect(poly!.getAttribute('fill')).toBe('var(--foam)');
  });

  it('VersionRing fills the current version and dims the previous', () => {
    const { container } = render(<>
      <VersionRing filled={false} />
      <VersionRing filled={true} />
    </>);
    const rings = [...container.querySelectorAll('.version-ring')];
    expect(rings).toHaveLength(2);
    expect(rings[0].getAttribute('class')).toContain('version-ring');
    expect(rings[0].getAttribute('class')).not.toContain('filled');
    expect(rings[1].getAttribute('class')).toContain('filled');
  });
});
