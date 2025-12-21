"use client";
import React, { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface LayoutInfo {
  id: string;
  name: string;
  description: string;
  json_schema: any;
}

interface TemplateSetting {
  description: string;
  ordered: boolean;
  default?: boolean;
}

interface TemplateResponse {
  templateID: string;
  templateName?: string;
  files: string[];
  settings: TemplateSetting | null;
}

const SchemaPage = () => {
  const searchParams = useSearchParams();
  const templateID = searchParams.get("group");
  const [layouts, setLayouts] = useState<LayoutInfo[]>([]);
  const [settings, setSettings] = useState<TemplateSetting | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!templateID) return;

    const fetchLayouts = async () => {
      try {
        // Fetch template list
        const res = await fetch("/api/templates");
        const templates: TemplateResponse[] = await res.json();

        const template = templates.find(t => t.templateID === templateID);
        if (!template) {
          setLoading(false);
          return;
        }

        // Build layout info from file names (simplified - no dynamic imports)
        const layoutInfos: LayoutInfo[] = template.files.map(fileName => {
          const file = fileName.replace(".tsx", "").replace(".ts", "");
          // Create a simple layout ID from file name
          const layoutId = file.toLowerCase().replace(/layout$/, "").replace(/slide$/, "");
          return {
            id: `${templateID}:${layoutId}`,
            name: file.replace(/([A-Z])/g, " $1").trim(),
            description: `${file} layout`,
            json_schema: {}
          };
        });

        setLayouts(layoutInfos);
        setSettings(template.settings);
        setLoading(false);
      } catch (error) {
        console.error("Error fetching layouts:", error);
        setLoading(false);
      }
    };

    fetchLayouts();
  }, [templateID]);

  if (!templateID) {
    return <div>No templateID provided</div>;
  }

  return (
    <div data-loading={loading.toString()}>
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div>
          <div data-layouts={JSON.stringify(layouts)}>
            <pre>{JSON.stringify(layouts, null, 2)}</pre>
          </div>
          <div data-settings={JSON.stringify(settings)}>
            <pre>{JSON.stringify(settings, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default SchemaPage;
