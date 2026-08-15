import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./styles.css";
import { AppShell } from "./components/AppShell";
import { ModelStatusProvider } from "./model-status";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { CreatorsPage } from "./pages/CreatorsPage";
import { CreatorVideosPage } from "./pages/CreatorVideosPage";
import { ArticlePage } from "./pages/ArticlePage";
import { SettingsPage } from "./pages/SettingsPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { FavoriteArticlePage } from "./pages/FavoriteArticlePage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ModelStatusProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="creators" element={<CreatorsPage />} />
            <Route path="creators/:secUid" element={<CreatorVideosPage />} />
            <Route path="articles/:awemeId" element={<ArticlePage />} />
            <Route path="favorites" element={<FavoritesPage />} />
            <Route path="favorites/:awemeId" element={<FavoriteArticlePage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ModelStatusProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
