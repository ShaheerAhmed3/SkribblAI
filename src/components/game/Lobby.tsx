import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, Game } from "../../lib/supabase";
import { Plus, Users, Play, LogOut, Brush } from "lucide-react";
import toast from "react-hot-toast";

const Lobby: React.FC = () => {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingGame, setCreatingGame] = useState(false);
  const [gameName, setGameName] = useState("");
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  //Fetch games from Supabase
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
      toast.error("Failed to load games");
    } finally {
      setLoading(false);
    }
  }, []);

  //Fetch games on mount
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

  //Create a new game
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
            max_rounds: 15,
            created_by: user?.id,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      toast.success("Game created successfully!");
      navigate(`/game/${data.id}`);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setCreatingGame(false);
      setGameName("");
    }
  };

  //Join a game
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
      toast.error(error.message);
    }
  };

  //Sign out
  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {}
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
    <div className="min-h-screen bg-indigo-50 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <div className="flex items-center space-x-3">
              <Brush className="h-10 w-10 text-indigo-600 rotate-12" />
              <h1 className="text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600 animate-pulse-slow drop-shadow-sm">
                SkribblAI
              </h1>
            </div>
            <p className="text-gray-700">
              Welcome, {user?.user_metadata?.username || "Player"}!
            </p>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center space-x-2 px-4 py-2 bg-gradient-to-r from-red-500 to-orange-500 text-white rounded-md shadow-lg hover:from-red-600 hover:to-orange-600 transition-all duration-300"
          >
            <LogOut className="h-5 w-5" />
            <span>Sign Out</span>
          </button>
        </div>

        {/* Create Game Section */}
        <div className="bg-white/70 backdrop-blur-md rounded-xl shadow-xl ring-1 ring-indigo-100 p-6 mb-8">
          <h2 className="text-3xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600">
            Create New Game
          </h2>
          <div className="flex space-x-4">
            <input
              type="text"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creatingGame && gameName.trim()) {
                  createGame();
                }
              }}
              placeholder="Enter game name..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={createGame}
              disabled={creatingGame || !gameName.trim()}
              className="flex items-center space-x-2 px-6 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-md shadow-lg hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300"
            >
              <Plus className="h-5 w-5" />
              <span>{creatingGame ? "Creating..." : "Create Game"}</span>
            </button>
          </div>
        </div>

        {/* Available Games */}
        <div className="bg-white/70 backdrop-blur-md rounded-xl shadow-xl ring-1 ring-indigo-100 p-6">
          <h2 className="text-3xl font-bold mb-6 bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600">
            Available Games
          </h2>
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
                  className="border border-transparent bg-white/80 backdrop-blur-sm rounded-lg p-4 hover:shadow-xl hover:-translate-y-1 transform transition-all"
                >
                  <h3 className="font-semibold text-lg mb-2">{game.name}</h3>
                  <p className="text-gray-600 text-sm mb-4">
                    Created {new Date(game.created_at).toLocaleDateString()}
                  </p>
                  <button
                    onClick={() => joinGame(game.id)}
                    className="flex items-center space-x-2 w-full px-4 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white rounded-md shadow-md hover:from-purple-600 hover:to-indigo-700 transition-all duration-300"
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
