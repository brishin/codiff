import { Menu } from '@base-ui/react/menu';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/CaretRight';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { useState } from 'react';
import { Button } from '../../core/react.ts';
import './view-menu.css';

type Settings = {
  agent: string;
  agents: Array<{ id: string; label: string }>;
  fastMode: boolean;
  model: string;
  models: Array<{ id: string; label: string }>;
  reasoningEffort: string;
  reasoningEfforts: Array<string>;
};

export function CodiffMenu({
  call,
}: {
  call: (method: string, params: unknown) => Promise<unknown>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = async (name: string, args: Record<string, string | boolean> = {}) => {
    setPending(true);
    setError('');
    try {
      const result = (await call('tools/call', { arguments: args, name })) as {
        content?: Array<{ text: string }>;
        isError?: boolean;
        structuredContent?: Settings;
      };
      if (result.isError || !result.structuredContent) {
        throw new Error(result.content?.[0]?.text || 'Could not read Codiff settings.');
      }
      setSettings(result.structuredContent);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const group = (
    label: string,
    key: string,
    selected: string,
    items: Array<{ id: string; label: string }>,
  ) => (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="thread-view-item" disabled={pending}>
        {label}
        <CaretRight aria-hidden size={12} />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner className="thread-view-positioner" sideOffset={4}>
          <Menu.Popup className="thread-view-menu">
            <Menu.RadioGroup
              onValueChange={(value) => {
                if (typeof value === 'string') {
                  void request('agent_settings_update', { key, value });
                }
              }}
              value={selected}
            >
              {items.map(({ id, label: itemLabel }) => (
                <Menu.RadioItem className="thread-view-item" disabled={pending} key={id} value={id}>
                  <Menu.RadioItemIndicator className="thread-view-check">
                    <Check size={14} />
                  </Menu.RadioItemIndicator>
                  {itemLabel}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) {
          void request('agent_settings_read');
        }
      }}
    >
      <Menu.Trigger aria-label="Agent menu" render={<Button variant="outline" />}>
        Agent <CaretDown aria-hidden size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" className="thread-view-positioner" sideOffset={6}>
          <Menu.Popup className="thread-view-menu">
            <Menu.Group>
              {settings ? (
                <>
                  {group('Agent', 'agent', settings.agent, settings.agents)}
                  {group('Model', 'model', settings.model, settings.models)}
                  {settings.agent === 'codex'
                    ? group(
                        'Reasoning Effort',
                        'reasoningEffort',
                        settings.reasoningEffort,
                        settings.reasoningEfforts.map((id) => ({ id, label: id || 'Default' })),
                      )
                    : null}
                  {settings.agent === 'codex' ? (
                    <Menu.CheckboxItem
                      checked={settings.fastMode}
                      className="thread-view-item"
                      disabled={pending}
                      onCheckedChange={(value) => {
                        void request('agent_settings_update', { key: 'fastMode', value });
                      }}
                    >
                      <Menu.CheckboxItemIndicator className="thread-view-check">
                        <Check size={14} />
                      </Menu.CheckboxItemIndicator>
                      Fast Mode
                    </Menu.CheckboxItem>
                  ) : null}
                </>
              ) : (
                <Menu.Item className="thread-view-item" disabled>
                  {pending ? 'Loading settings…' : 'Settings unavailable'}
                </Menu.Item>
              )}
              {error ? (
                <div className="thread-agent-error" role="alert">
                  {error}
                </div>
              ) : null}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
