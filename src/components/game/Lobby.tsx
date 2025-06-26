import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, Game } from "../../lib/supabase";
import { Plus, Users, Play, LogOut } from "lucide-react";
import toast from "react-hot-toast";

const Lobby: React.FC = () => {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingGame, setCreatingGame] = useState(false);
  const [gameName, setGameName] = useState("");
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const fetchGames = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("games")
        .select("*")
        .eq("status", "waiting")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setGames(data || []);
    } catch (error) {
      console.error("Error fetching games:", error);
      toast.error("Failed to load games");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();

    const channel = supabase
      .channel("games-lobby")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "games" },
        () => {
          fetchGames();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchGames]);

  const createGame = async () => {
    if (!gameName.trim()) return;

    setCreatingGame(true);
    try {
      const { data, error } = await supabase
        .from("games")
        .insert([
          {
            name: gameName,
            status: "waiting",
            round: 1,
            max_rounds: 100,
            created_by: user?.id,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      toast.success("Game created successfully!");
      navigate(`/game/${data.id}`);
    } catch (error: any) {
      console.error("Error creating game:", error);
      toast.error(error.message);
    } finally {
      setCreatingGame(false);
      setGameName("");
    }
  };

  const joinGame = async (gameId: string) => {
    try {
      const { error } = await supabase.from("game_players").insert([
        {
          game_id: gameId,
          user_id: user?.id,
          username: user?.user_metadata?.username || "Anonymous",
          score: 0,
          is_drawing: false,
        },
      ]);

      if (error) throw error;

      toast.success("Joined game successfully!");
      navigate(`/game/${gameId}`);
    } catch (error: any) {
      console.error("Error joining game:", error);
      toast.error(error.message);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading games...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-4xl font-bold text-gray-900">SkribblAI</h1>
            <p className="text-gray-600">
              Welcome, {user?.user_metadata?.username || "Player"}!
            </p>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
          >
            <LogOut className="h-5 w-5" />
            <span>Sign Out</span>
          </button>
        </div>

        {/* Create Game Section */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-8">
          <h2 className="text-2xl font-semibold mb-4">Create New Game</h2>
          <div className="flex space-x-4">
            <input
              type="text"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
              placeholder="Enter game name..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={createGame}
              disabled={creatingGame || !gameName.trim()}
              className="flex items-center space-x-2 px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="h-5 w-5" />
              <span>{creatingGame ? "Creating..." : "Create Game"}</span>
            </button>
          </div>
        </div>

        {/* Available Games */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-semibold mb-6">Available Games</h2>
          {games.length === 0 ? (
            <div className="text-center py-12">
              <Users className="h-16 w-16 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">
                No games available. Create one to get started!
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {games.map((game) => (
                <div
                  key={game.id}
                  className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
                >
                  <h3 className="font-semibold text-lg mb-2">{game.name}</h3>
                  <p className="text-gray-600 text-sm mb-4">
                    Created {new Date(game.created_at).toLocaleDateString()}
                  </p>
                  <button
                    onClick={() => joinGame(game.id)}
                    className="flex items-center space-x-2 w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                  >
                    <Play className="h-4 w-4" />
                    <span>Join Game</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Lobby;
