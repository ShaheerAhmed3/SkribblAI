import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./contexts/AuthContext";
import Login from "./components/auth/Login";
import Register from "./components/auth/Register";
import Lobby from "./components/game/Lobby";
import GameRoom from "./components/game/GameRoom";
import LoadingSpinner from "./components/ui/LoadingSpinner";

const App: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/lobby" replace /> : <Login />}
        />
        <Route
          path="/register"
          element={user ? <Navigate to="/lobby" replace /> : <Register />}
        />
        <Route
          path="/lobby"
          element={user ? <Lobby /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/game/:gameId"
          element={user ? <GameRoom /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/"
          element={<Navigate to={user ? "/lobby" : "/login"} replace />}
        />
      </Routes>
    </div>
  );
};

export default App;
