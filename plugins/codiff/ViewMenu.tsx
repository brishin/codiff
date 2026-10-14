import { Menu } from '@base-ui/react/menu';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown';
import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '../../core/react.ts';
import type { OnlineCodiffPreferences } from '../../web/src/ReviewSettings.tsx';
import './view-menu.css';

export function ViewMenu({
  expandUnchanged,
  loading,
  preferences,
  refresh,
  setExpandUnchanged,
  setPreferences,
}: {
  expandUnchanged: boolean;
  loading: boolean;
  preferences: OnlineCodiffPreferences;
  refresh: () => Promise<void>;
  setExpandUnchanged: (value: boolean) => void;
  setPreferences: Dispatch<SetStateAction<OnlineCodiffPreferences>>;
}) {
  const setPreference = <K extends keyof OnlineCodiffPreferences>(
    key: K,
    value: OnlineCodiffPreferences[K],
  ) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  };
  const resize = (delta: number) =>
    setPreference('codeFontSize', Math.max(10, Math.min(32, preferences.codeFontSize + delta)));
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="View menu" render={<Button variant="outline" />}>
        View <CaretDown aria-hidden size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" className="thread-view-positioner" sideOffset={6}>
          <Menu.Popup className="thread-view-menu">
            <Menu.Group>
              <Menu.GroupLabel className="thread-view-label">Diff</Menu.GroupLabel>
              <Menu.RadioGroup
                onValueChange={(value) => {
                  if (value === 'split' || value === 'unified') {
                    setPreference('diffStyle', value);
                  }
                }}
                value={preferences.diffStyle}
              >
                {(['split', 'unified'] as const).map((style) => (
                  <Menu.RadioItem className="thread-view-item" key={style} value={style}>
                    <Menu.RadioItemIndicator className="thread-view-check">
                      <Check size={14} />
                    </Menu.RadioItemIndicator>
                    {style === 'split' ? 'Split' : 'Unified'}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <Menu.CheckboxItem
                checked={preferences.wordWrap}
                className="thread-view-item"
                onCheckedChange={(checked) => setPreference('wordWrap', checked)}
              >
                <Menu.CheckboxItemIndicator className="thread-view-check">
                  <Check size={14} />
                </Menu.CheckboxItemIndicator>
                Word Wrap
              </Menu.CheckboxItem>
              <Menu.CheckboxItem
                checked={preferences.showWhitespace}
                className="thread-view-item"
                onCheckedChange={(checked) => setPreference('showWhitespace', checked)}
              >
                <Menu.CheckboxItemIndicator className="thread-view-check">
                  <Check size={14} />
                </Menu.CheckboxItemIndicator>
                Show Whitespace
              </Menu.CheckboxItem>
              <Menu.CheckboxItem
                checked={expandUnchanged}
                className="thread-view-item"
                onCheckedChange={setExpandUnchanged}
              >
                <Menu.CheckboxItemIndicator className="thread-view-check">
                  <Check size={14} />
                </Menu.CheckboxItemIndicator>
                Expand Unchanged Lines
              </Menu.CheckboxItem>
            </Menu.Group>
            <Menu.Separator className="thread-view-separator" />
            <Menu.Group>
              <Menu.GroupLabel className="thread-view-label">
                Font Size · {preferences.codeFontSize}px
              </Menu.GroupLabel>
              <Menu.Item
                className="thread-view-item"
                disabled={preferences.codeFontSize >= 32}
                onClick={() => resize(1)}
              >
                Increase <kbd>⌘+</kbd>
              </Menu.Item>
              <Menu.Item
                className="thread-view-item"
                disabled={preferences.codeFontSize <= 10}
                onClick={() => resize(-1)}
              >
                Decrease <kbd>⌘−</kbd>
              </Menu.Item>
              <Menu.Item
                className="thread-view-item"
                onClick={() => setPreference('codeFontSize', 13)}
              >
                Reset <kbd>⌘0</kbd>
              </Menu.Item>
            </Menu.Group>
            <Menu.Separator className="thread-view-separator" />
            <Menu.Group>
              <Menu.GroupLabel className="thread-view-label">Theme</Menu.GroupLabel>
              <Menu.RadioGroup
                onValueChange={(value) => {
                  if (value === 'system' || value === 'light' || value === 'dark') {
                    setPreference('theme', value);
                  }
                }}
                value={preferences.theme}
              >
                {(['system', 'light', 'dark'] as const).map((theme) => (
                  <Menu.RadioItem className="thread-view-item" key={theme} value={theme}>
                    <Menu.RadioItemIndicator className="thread-view-check">
                      <Check size={14} />
                    </Menu.RadioItemIndicator>
                    {theme === 'system' ? 'Match System' : theme === 'light' ? 'Light' : 'Dark'}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="thread-view-separator" />
            <Menu.Item
              className="thread-view-item"
              disabled={loading}
              onClick={() => {
                void refresh();
              }}
            >
              Refresh Changes <kbd>⌘R</kbd>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
