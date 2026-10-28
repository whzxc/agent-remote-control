import "./style.css";
import { createRoot } from "react-dom/client";
import UiProvider from "./components/UiProvider";
import App from "./App";
import "./product.css";
import "./pets/pets.css";
import { scenarioName } from './scenarioMode';
const ready = import.meta.env.DEV && scenarioName ? await (await import('./scenarios')).installScenario(scenarioName) : undefined;
createRoot(document.getElementById("app")!).render(
  <UiProvider>
    <App />
  </UiProvider>,
);

if (ready) requestAnimationFrame(() => { void ready().catch(async error => { (await import("./state/scenarioReadiness")).finishScenario(String(error)); }); });
