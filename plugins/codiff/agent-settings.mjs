import agents from '../../electron/agent.cjs';
import discovery from '../../electron/codex-models.cjs';
import configStore from '../../electron/config.cjs';

export const createAgentSettings = ({
  readConfig = configStore.readConfig,
  readModels = discovery.readCodexModels,
  writeConfig = configStore.writeConfig,
} = {}) => {
  let catalog;
  const codexModels = () =>
    (catalog ??= readModels().catch(() =>
      agents
        .getAgent('codex')
        .models.map((model) => ({ ...model, reasoningEfforts: ['low', 'medium', 'high'] })),
    ));
  const read = async () => {
    const config = readConfig();
    const agent = agents.getAgent(config.settings.agentBackend);
    const model = config.settings[agent.modelSettingKey];
    const models = agent.id === 'codex' ? await codexModels() : agent.models;
    const selected = models.find((item) => item.id === model);
    const effort = config.settings.openAIReasoningEffort;
    const advertised = selected?.reasoningEfforts ?? ['low', 'medium', 'high'];
    return {
      agent: agent.id,
      agents: agents.listAgents().map(({ id, label }) => ({ id, label })),
      fastMode: config.settings.openAIFastMode,
      model,
      models: agents
        .getAgentMenuModels(agent, model, models)
        .map(({ id, label }) => ({ id, label })),
      reasoningEffort: effort,
      reasoningEfforts:
        agent.id === 'codex' ? [...new Set(['', ...advertised, ...(effort ? [effort] : [])])] : [],
    };
  };
  const update = async ({ key, value }) => {
    const current = await read();
    const config = readConfig();
    if (
      agents.getAgent(config.settings.agentBackend).id !== current.agent ||
      config.settings[agents.getAgent(current.agent).modelSettingKey] !== current.model
    ) {
      throw new Error('Codiff settings changed. Reopen the menu and try again.');
    }
    if (key === 'agent' && current.agents.some(({ id }) => id === value)) {
      config.settings.agentBackend = value;
    } else if (key === 'model' && current.models.some(({ id }) => id === value)) {
      const agent = agents.getAgent(config.settings.agentBackend);
      config.settings[agent.modelSettingKey] = agent.normalizeModel(value);
      if (agent.id === 'codex') {
        const selected = (await codexModels()).find(({ id }) => id === value);
        if (
          selected &&
          config.settings.openAIReasoningEffort &&
          !selected.reasoningEfforts.includes(config.settings.openAIReasoningEffort)
        ) {
          config.settings.openAIReasoningEffort = '';
        }
      }
    } else if (
      key === 'reasoningEffort' &&
      current.agent === 'codex' &&
      current.reasoningEfforts.includes(value)
    ) {
      config.settings.openAIReasoningEffort = value;
    } else if (key === 'fastMode' && current.agent === 'codex' && typeof value === 'boolean') {
      config.settings.openAIFastMode = value;
    } else {
      throw new Error('Choose an available Codiff agent, model, or reasoning effort.');
    }
    writeConfig(config);
    return read();
  };
  return { read, update };
};

export const agentSettings = createAgentSettings();
