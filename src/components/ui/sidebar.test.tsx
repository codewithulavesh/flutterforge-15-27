// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './sidebar';

function StateProbe() {
  const { state, open, isMobile, openMobile } = useSidebar();
  return <output data-testid="state">{`${state}:${open}:${isMobile}:${openMobile}`}</output>;
}

function renderSidebar(props: Partial<ComponentProps<typeof SidebarProvider>> = {}) {
  return render(
    <SidebarProvider {...props}>
      <Sidebar>
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>Projects</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarTrigger />
      <StateProbe />
    </SidebarProvider>,
  );
}

function rail() {
  return document.querySelector('aside');
}

function state(): string {
  return screen.getByTestId('state').textContent ?? '';
}

describe('SidebarProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('starts expanded on desktop and collapses from the trigger', async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(rail()?.getAttribute('data-state')).toBe('expanded');
    expect(rail()?.style.width).toBe('16.5rem');

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(rail()?.getAttribute('data-state')).toBe('collapsed');
    expect(rail()?.getAttribute('data-collapsible')).toBe('icon');
    expect(rail()?.style.width).toBe('3.5rem');
    expect(window.localStorage.getItem('ff-sidebar-open')).toBe('false');
  });

  it('restores the persisted rail state', () => {
    window.localStorage.setItem('ff-sidebar-open', 'false');
    renderSidebar();

    expect(rail()?.getAttribute('data-state')).toBe('collapsed');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('honours the defaultOpen fallback when nothing is stored', () => {
    renderSidebar({ defaultOpen: false });
    expect(rail()?.getAttribute('data-state')).toBe('collapsed');
  });

  it('leaves controlled state to the owner and never persists it', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSidebar({ open: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(rail()?.getAttribute('data-state')).toBe('collapsed');
    expect(window.localStorage.getItem('ff-sidebar-open')).toBeNull();
  });

  it('toggles with the keyboard shortcut, but not while typing', async () => {
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <input aria-label="Project name" />
          </SidebarContent>
          <StateProbe />
        </Sidebar>
      </SidebarProvider>,
    );

    const input = screen.getByRole('textbox', { name: 'Project name' });
    await user.click(input);
    fireEvent.keyDown(input, { key: 'b', metaKey: true });
    expect(state()).toBe('expanded:true:false:false');

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(state()).toBe('collapsed:false:false:false');
  });

  it('does not keyboard-toggle when the shortcut is disabled', () => {
    renderSidebar({ keyboardShortcut: false });
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(state()).toBe('expanded:true:false:false');
  });

  it('opens a dialog drawer below the 900px breakpoint', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });

    try {
      renderSidebar();

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(state()).toBe('collapsed:false:true:false');

      await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

      expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
      expect(state()).toBe('collapsed:false:true:true');
      expect(document.body.style.overflow).toBe('hidden');

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.body.style.overflow).toBe('');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    }
  });
});

describe('SidebarMenuButton', () => {
  afterEach(() => cleanup());

  it('merges its classes and active state onto a render-prop link', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive
                  render={<a className="custom-link" href="/agents" />}
                >
                  Agents
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );

    const link = screen.getByRole('link', { name: 'Agents' });
    expect(link.getAttribute('href')).toBe('/agents');
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.className).toContain('custom-link');
    expect(link.className).toContain('rounded-lg');
  });
});
