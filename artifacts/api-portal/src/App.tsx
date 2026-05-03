import { useState } from "react";
import ConfigPage from "./pages/ConfigPage";
import ModelsPage from "./pages/ModelsPage";
import DocsPage from "./pages/DocsPage";

type Tab = "config" | "models" | "docs";

const TABS: { id: Tab; label: string }[] = [
  { id: "config", label: "配置" },
  { id: "models", label: "模型管理" },
  { id: "docs", label: "API 文档" },
];

function GatewayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="6" fill="hsl(221 83% 63%)" />
      <path d="M7 12h10M12 7v10M7 7l10 10M17 7L7 17" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("config");

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <GatewayIcon />
          <div>
            <h1 className="text-sm font-semibold text-foreground leading-none">AI 网关</h1>
            <p className="text-xs text-muted-foreground leading-none mt-0.5">管理门户</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <span className="size-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">运行中</span>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <div className="border-b border-border bg-card/30">
        <div className="max-w-5xl mx-auto px-4">
          <nav className="flex gap-0">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Content */}
      <main className="flex-1">
        <div className="max-w-5xl mx-auto px-4 py-6">
          {activeTab === "config" && <ConfigPage />}
          {activeTab === "models" && <ModelsPage />}
          {activeTab === "docs" && <DocsPage />}
        </div>
      </main>
    </div>
  );
}
