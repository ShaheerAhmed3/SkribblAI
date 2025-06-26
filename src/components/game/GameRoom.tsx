import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, Game, GamePlayer, ChatMessage } from "../../lib/supabase";
import { ArrowLeft, Send } from "lucide-react";
import toast from "react-hot-toast";
import DrawingCanvas from "./DrawingCanvas";
import { loadWordList } from "../../lib/wordList";

const GameRoom: React.FC = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentDrawer, setCurrentDrawer] = useState<string | null>(null);
  const [currentWord, setCurrentWord] = useState<string>("");
  const [timeLeft, setTimeLeft] = useState(60);
  const [gameStatus, setGameStatus] = useState<
    "waiting" | "choosing_word" | "playing" | "finished"
  >("waiting");

  // Word list & choices
  const [wordList, setWordList] = useState<string[]>([]);
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchGameData = useCallback(async () => {
    if (!gameId) return;
    try {
      // Fetch game
      const { data: gameData, error: gameError } = await supabase
        .from("games")
        .select("*")
        .eq("id", gameId)
        .single();

      if (gameError) throw gameError;
      setGame(gameData);
      setGameStatus(gameData.status);
      setCurrentDrawer(gameData.current_drawer ?? null);
      setCurrentWord(gameData.current_word || "");

      // Fetch players
      const { data: playersData, error: playersError } = await supabase
        .from("game_players")
        .select("*")
        .eq("game_id", gameId);

      if (playersError) throw playersError;
      setPlayers(playersData || []);

      // Fetch messages
      const { data: messagesData, error: messagesError } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("game_id", gameId)
        .order("created_at", { ascending: true });

      if (messagesError) throw messagesError;
      setMessages(messagesData || []);

      // Check if user is in the game
      const isPlayerInGame = playersData?.some((p) => p.user_id === user?.id);
      if (!isPlayerInGame && gameData.status === "waiting") {
        // joinGame logic is now inside fetchGameData to avoid dependency issues
        await supabase.from("game_players").insert([
          {
            game_id: gameId,
            user_id: user?.id,
            username: user?.user_metadata?.username || "Anonymous",
            score: 0,
            is_drawing: false,
          },
        ]);
      }
    } catch (error) {
      console.error("Error fetching game data:", error);
      toast.error("Failed to load game");
    } finally {
      setLoading(false);
    }
  }, [gameId, user]);

  // Subscribe to Realtime changes (only once per room)
  useEffect(() => {
    // Wait until auth session is ready before opening the Realtime channel
    if (!gameId || authLoading || !user) return;

    let cancelled = false;

    const createChannel = () => {
      const channel = supabase.channel(`game-room:${gameId}`);

      channel
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "games",
            filter: `id=eq.${gameId}`,
          },
          (payload) => {
            const updatedGame = payload.new as Game;
            setGame(updatedGame);
            setGameStatus(updatedGame.status);
            setCurrentDrawer(updatedGame.current_drawer ?? null);
            setCurrentWord(updatedGame.current_word || "");

            if (updatedGame.status === "playing") {
              setTimeLeft(60);
            }
          }
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "chat_messages",
            filter: `game_id=eq.${gameId}`,
          },
          (payload) => {
            const newMessage = payload.new as ChatMessage;
            setMessages((prev) => [...prev, newMessage]);
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "game_players",
            filter: `game_id=eq.${gameId}`,
          },
          () => {
            fetchGameData(); // Re-fetch all players and game data on change
          }
        )
        .subscribe((status) => {
          console.log("game room channel", status);

          if (status === "SUBSCRIBED") {
            console.log("Successfully subscribed to game room channel!");
          }

          if (status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
            console.warn("Channel failed (", status, "), retrying in 3s...");
            supabase.removeChannel(channel);

            if (!cancelled) {
              setTimeout(() => {
                if (!cancelled) createChannel();
              }, 3000);
            }
          }
        });

      return channel;
    };

    const channel = createChannel();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [gameId, user?.id, authLoading]); // include auth/loading so the effect runs once the session is available

  // Fetch initial & subsequent game data whenever the room or auth user changes
  useEffect(() => {
    if (!gameId) return;
    fetchGameData();
  }, [gameId, user, fetchGameData]);

  useEffect(() => {
    if (gameStatus === "playing" && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            endRound();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [gameStatus, timeLeft]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load words once on mount
  useEffect(() => {
    loadWordList().then(setWordList);
  }, []);

  const startGame = async () => {
    try {
      const randomPlayer = players[Math.floor(Math.random() * players.length)];

      const { error } = await supabase
        .from("games")
        .update({
          status: "choosing_word",
          current_word: "",
          current_drawer: randomPlayer.user_id,
          round: 1,
        })
        .eq("id", gameId);

      if (error) throw error;

      setGameStatus("choosing_word");
      setCurrentWord("");
      setCurrentDrawer(randomPlayer.user_id);
    } catch (error: any) {
      console.error("Error starting game:", error);
      toast.error(error.message);
    }
  };

  const endRound = async () => {
    try {
      const nextRound = (game?.round || 1) + 1;
      const isGameFinished = nextRound > (game?.max_rounds || 5);

      if (isGameFinished) {
        await supabase
          .from("games")
          .update({ status: "finished" })
          .eq("id", gameId);

        setGameStatus("finished");
        toast.success("Game finished!");
      } else {
        const remainingPlayers = players.filter(
          (p) => p.user_id !== currentDrawer
        );
        const nextDrawer =
          remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];

        await supabase
          .from("games")
          .update({
            round: nextRound,
            current_word: "",
            current_drawer: nextDrawer.user_id,
            status: "choosing_word",
          })
          .eq("id", gameId);

        setCurrentWord("");
        setCurrentDrawer(nextDrawer.user_id);
        setGameStatus("choosing_word");
      }
    } catch (error: any) {
      console.error("Error ending round:", error);
      toast.error(error.message);
    }
  };

  // Handle word choices when it's the user's turn to pick
  useEffect(() => {
    if (
      gameStatus === "choosing_word" &&
      user?.id === currentDrawer &&
      wordChoices.length === 0 &&
      wordList.length >= 3
    ) {
      const shuffled = [...wordList].sort(() => 0.5 - Math.random());
      setWordChoices(shuffled.slice(0, 3));
    }

    // Clean up choices when not needed
    if (gameStatus !== "choosing_word" && wordChoices.length > 0) {
      setWordChoices([]);
    }
  }, [gameStatus, currentDrawer, user, wordList, wordChoices.length]);

  const chooseWord = async (word: string) => {
    try {
      const { error } = await supabase
        .from("games")
        .update({
          current_word: word,
          status: "playing",
        })
        .eq("id", gameId);

      if (error) throw error;

      setCurrentWord(word);
      setGameStatus("playing");
      setWordChoices([]);
      setTimeLeft(60);
    } catch (error) {
      console.error("Error choosing word:", error);
      toast.error("Failed to choose word");
    }
  };

  const sendMessage = async () => {
    if (!newMessage.trim()) return;

    try {
      const isGuess = gameStatus === "playing" && user?.id !== currentDrawer;
      const isCorrect =
        isGuess &&
        newMessage.toLowerCase().trim() === currentWord.toLowerCase();

      const { error } = await supabase.from("chat_messages").insert([
        {
          game_id: gameId,
          user_id: user?.id,
          username: user?.user_metadata?.username || "Anonymous",
          message: newMessage,
          is_guess: isGuess,
          is_correct: isCorrect,
        },
      ]);

      if (error) throw error;

      if (isCorrect) {
        toast.success("Correct guess!");
        // Update player score
        await supabase
          .from("game_players")
          .update({
            score:
              (players.find((p) => p.user_id === user?.id)?.score || 0) + 10,
          })
          .eq("game_id", gameId)
          .eq("user_id", user?.id);
      }

      setNewMessage("");
    } catch (error: any) {
      console.error("Error sending message:", error);
      toast.error(error.message);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading game...</p>
        </div>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600">Game not found</p>
          <button
            onClick={() => navigate("/lobby")}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={() => navigate("/lobby")}
                className="flex items-center space-x-2 text-gray-600 hover:text-gray-900"
              >
                <ArrowLeft className="h-5 w-5" />
                <span>Back to Lobby</span>
              </button>
              <div>
                <h1 className="text-xl font-semibold">{game.name}</h1>
                <p className="text-sm text-gray-600">
                  Round {game.round}/{game.max_rounds} • {players.length}{" "}
                  players
                </p>
              </div>
            </div>
            {gameStatus === "playing" && (
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {timeLeft}s
                </div>
                <div className="text-sm text-gray-600">Time remaining</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Players List */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-sm p-4">
              <h3 className="font-semibold mb-4">Players</h3>
              <div className="space-y-2">
                {players.map((player) => (
                  <div
                    key={player.id}
                    className={`flex items-center justify-between p-2 rounded ${
                      player.user_id === currentDrawer
                        ? "bg-blue-50 border border-blue-200"
                        : "bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                      <span className="font-medium">{player.username}</span>
                      {player.user_id === currentDrawer && (
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                          Drawing
                        </span>
                      )}
                    </div>
                    <span className="text-sm font-semibold">
                      {player.score}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Game Area */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow-sm p-4">
              {gameStatus === "waiting" ? (
                <div className="text-center py-12">
                  <h3 className="text-xl font-semibold mb-4">
                    {players.length >= 1
                      ? "Ready to start?"
                      : "Waiting for players..."}
                  </h3>
                  <p className="text-gray-600 mb-6">
                    {players.length} player{players.length !== 1 ? "s" : ""}{" "}
                    joined
                  </p>
                  {players.length >= 1 && (
                    <button
                      onClick={startGame}
                      className="px-6 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors animate-pulse"
                    >
                      Start Game (for testing)
                    </button>
                  )}
                </div>
              ) : gameStatus === "choosing_word" ? (
                <div className="text-center py-12">
                  {user?.id === currentDrawer ? (
                    <div>
                      <h3 className="text-xl font-semibold mb-4">
                        Choose a word
                      </h3>
                      <div className="space-x-4">
                        {wordChoices.map((word) => (
                          <button
                            key={word}
                            onClick={() => chooseWord(word)}
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                          >
                            {word}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-gray-600">
                      Waiting for the drawer to choose a word...
                    </p>
                  )}
                </div>
              ) : gameStatus === "playing" ? (
                <div>
                  {user?.id === currentDrawer ? (
                    <div>
                      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                        <p className="text-center font-semibold text-blue-800">
                          You're drawing! Word:{" "}
                          <span className="text-lg">{currentWord}</span>
                        </p>
                      </div>
                      <DrawingCanvas
                        gameId={gameId!}
                        currentDrawerId={currentDrawer}
                      />
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-md">
                        <p className="font-semibold text-gray-800">
                          {
                            players.find((p) => p.user_id === currentDrawer)
                              ?.username
                          }{" "}
                          is drawing
                        </p>
                        <p className="text-sm text-gray-600 mt-1">
                          Word:{" "}
                          {currentWord
                            .split("")
                            .map(() => "_")
                            .join(" ")}
                        </p>
                      </div>
                      <DrawingCanvas
                        gameId={gameId!}
                        readOnly
                        currentDrawerId={currentDrawer}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12">
                  <h3 className="text-xl font-semibold mb-4">Game Finished!</h3>
                  <div className="space-y-2">
                    {players
                      .sort((a, b) => b.score - a.score)
                      .map((player, index) => (
                        <div
                          key={player.id}
                          className="flex items-center justify-between p-2 bg-gray-50 rounded"
                        >
                          <div className="flex items-center space-x-2">
                            <span className="font-semibold">#{index + 1}</span>
                            <span>{player.username}</span>
                          </div>
                          <span className="font-semibold">
                            {player.score} points
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Chat */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-sm h-96 flex flex-col">
              <div className="p-4 border-b">
                <h3 className="font-semibold">Chat</h3>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`p-2 rounded ${
                      message.is_correct
                        ? "bg-green-50 border border-green-200"
                        : message.is_guess
                        ? "bg-yellow-50 border border-yellow-200"
                        : "bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">
                        {message.username}
                      </span>
                      <span className="text-xs text-gray-500">
                        {new Date(message.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm mt-1">{message.message}</p>
                    {message.is_correct && (
                      <p className="text-xs text-green-600 font-medium mt-1">
                        Correct guess!
                      </p>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 border-t">
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyPress={(e) => e.key === "Enter" && sendMessage()}
                    placeholder="Type your message..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={sendMessage}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GameRoom;
