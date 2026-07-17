import { useState } from "react";
import { Tabs } from "@neo4j-ndl/react";
import ExploreTab from "./components/ExploreTab";
import ScenariosTab from "./components/ScenariosTab";
import FlowTab from "./components/FlowTab";
import BenchmarkTab from "./components/BenchmarkTab";
import QueryAuditDrawer from "./components/QueryAuditDrawer";
import "./App.css";

function App() {
  const [activeTab, setActiveTab] = useState("explore");

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <h1>
            <span className="header-icon">&#127760;</span> WAN Digital Twin — TwinModel
          </h1>
          <p className="subtitle">
            Batfish calcule, Neo4j mémorise et explique — topology, blast radius, SPOF, and the
            Intent → OperationalPath → Compliance flow layer, all from one graph
          </p>
        </div>
      </header>

      <div className="app-tabs">
        <Tabs fill="underline" onChange={setActiveTab} value={activeTab}>
          <Tabs.Tab id="explore">Explore</Tabs.Tab>
          <Tabs.Tab id="scenarios">Scenarios</Tabs.Tab>
          <Tabs.Tab id="flow">Flow &amp; Compliance</Tabs.Tab>
          <Tabs.Tab id="benchmark">Benchmark</Tabs.Tab>
        </Tabs>
      </div>

      <main className="app-main">
        {activeTab === "explore" && <ExploreTab />}
        {activeTab === "scenarios" && <ScenariosTab />}
        {activeTab === "flow" && <FlowTab />}
        {activeTab === "benchmark" && <BenchmarkTab />}
      </main>

      <QueryAuditDrawer />
    </div>
  );
}

export default App;
