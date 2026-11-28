import type { PermissionsStateDTO, ToolCatalogItemDTO } from '@mj/shared';
import type { OpenAiToolDeclaration } from '../xaiClient.js';
import { createBuiltinTools } from './builtinTools.js';
import type { MjToolDefinition } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, MjToolDefinition<any>>();

  constructor(initialTools: Array<MjToolDefinition<any>> = []) {
    for (const tool of initialTools) {
      this.register(tool);
    }
  }

  public register(tool: MjToolDefinition<any>): void {
    this.tools.set(tool.name, tool);
  }

  public get(name: string): MjToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  public listAll(): Array<MjToolDefinition<any>> {
    return Array.from(this.tools.values());
  }

  /**
   * Returns only non-blocked tools whose master (`toolCalling`) and individual
   * capability permission are currently enabled in `PermissionsStore`.
   */
  public listPermittedTools(permissions: PermissionsStateDTO): Array<MjToolDefinition<any>> {
    if (!permissions.toolCalling) {
      return [];
    }
    return this.listAll().filter((tool) => {
      if (tool.risk === 'blocked') return false;
      if (!permissions[tool.requiredPermission]) return false;
      if (tool.requiredPermissions?.some((perm) => !permissions[perm])) {
        return false;
      }
      return true;
    });
  }

  public listCatalog(includeBlocked = false): ToolCatalogItemDTO[] {
    return this.listAll()
      .filter((t) => includeBlocked || t.risk !== 'blocked')
      .map((t) => ({
        name: t.name,
        description: t.description,
        risk: t.risk,
        requiredPermission: t.requiredPermission,
        parametersSchema: t.jsonSchema,
      }));
  }

  public toOpenAiTools(permissions: PermissionsStateDTO): OpenAiToolDeclaration[] {
    return this.listPermittedTools(permissions).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
      },
    }));
  }

  public toGeminiLiveFunctionDeclarations(
    permissions: PermissionsStateDTO,
  ): Array<Record<string, unknown>> {
    return this.listPermittedTools(permissions).map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.geminiParameters ? { parameters: tool.geminiParameters } : {}),
    }));
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(createBuiltinTools());
}
