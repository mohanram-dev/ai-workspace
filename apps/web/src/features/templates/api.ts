import type { CreateTemplateInput, TemplateDto, UpdateTemplateInput } from "@aiw/shared";
import { apiFetch } from "@/lib/api-client";

export async function listTemplates(): Promise<TemplateDto[]> {
  const { templates } = await apiFetch<{ templates: TemplateDto[] }>("/api/templates");
  return templates;
}

export function createTemplate(input: CreateTemplateInput): Promise<TemplateDto> {
  return apiFetch("/api/templates", { method: "POST", body: JSON.stringify(input) });
}

export function updateTemplate(id: string, input: UpdateTemplateInput): Promise<TemplateDto> {
  return apiFetch(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteTemplate(id: string): Promise<void> {
  return apiFetch(`/api/templates/${id}`, { method: "DELETE" });
}

/** Moves the template to the top of the menu. Failing to record it never blocks using it. */
export function markTemplateUsed(id: string): void {
  void apiFetch(`/api/templates/${id}/use`, { method: "POST" }).catch(() => {});
}
