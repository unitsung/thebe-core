import type { ThebeAgent } from "../../../../agent/index.ts";
import { attachSelectList } from "../../overlays/index.ts";
import type { SlashHost } from "../context.ts";

export async function handleSkillsCommand(
  host: SlashHost,
  agent: ThebeAgent,
  arg: string,
): Promise<boolean> {
  const [action, ...rest] = arg.split(/\s+/).filter(Boolean);
  const skillName = rest.join(" ");
  if (action === "list" || (!action && arg === "list")) {
    const skills = await agent.listSkills();
    host.notice(skills.length === 0
      ? "no skills found in .thebe/skills or .pi/skills (project/global)"
      : skills.map((skill) => `${skill.enabled ? "[✓]" : "[ ]"} ${skill.name} (${skill.scope}) — ${skill.description}`).join("\n"));
    return true;
  }
  if (action === "enable" && skillName) {
    await agent.enableSkill(skillName);
    host.notice(`enabled skill ${skillName}`);
    return true;
  }
  if (action === "disable" && skillName) {
    await agent.disableSkill(skillName);
    host.notice(`disabled skill ${skillName}`);
    return true;
  }
  const skills = await agent.listSkills();
  if (skills.length === 0) {
    host.notice("no skills found in .thebe/skills or .pi/skills (project/global)");
    return true;
  }
  const picked = await attachSelectList(
    host.tui,
    skills.map((skill) => ({
      label: `${skill.enabled ? "[✓]" : "[ ]"} ${skill.name} (${skill.scope}) — ${skill.description}`,
      value: skill.name,
    })),
    host.editor,
    undefined,
    host.getActiveSelectListTheme(),
  );
  if (!picked) return true;
  const skill = await agent.getSkill(picked.value);
  if (!skill) return true;
  const actionItem = await attachSelectList(
    host.tui,
    [
      { label: skill.enabled ? "Disable skill" : "Enable skill", value: "toggle" },
      { label: "View instructions", value: "view" },
    ],
    host.editor,
    undefined,
    host.getActiveSelectListTheme(),
  );
  if (!actionItem) return true;
  if (actionItem.value === "toggle") {
    if (skill.enabled) {
      await agent.disableSkill(skill.name);
      host.notice(`disabled skill ${skill.name}`);
    } else {
      await agent.enableSkill(skill.name);
      host.notice(`enabled skill ${skill.name}`);
    }
  } else {
    host.notice(`--- ${skill.name} ---\n${(skill.content ?? "").trim() || "(empty skill)"}`);
  }
  return true;
}
