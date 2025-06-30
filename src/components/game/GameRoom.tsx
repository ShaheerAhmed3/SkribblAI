import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, Game, GamePlayer, ChatMessage } from "../../lib/supabase";
import { ArrowLeft, Send } from "lucide-react";
import toast from "react-hot-toast";
import DrawingCanvas from "./DrawingCanvas";
import { loadWordList } from "../../lib/wordList";

// ----- Game constants -----
const ROUND_DURATION = 80; // seconds per drawing round

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
  const [timeLeft, setTimeLeft] = useState(ROUND_DURATION);
  const [wordChoiceTimeLeft, setWordChoiceTimeLeft] = useState(10);
  const [gameStatus, setGameStatus] = useState<
    "waiting" | "choosing_word" | "playing" | "round_summary" | "finished"
  >("waiting");

  // Word list & choices
  const [wordList, setWordList] = useState<string[]>([]);
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  // Player tracking for the current round
  const [correctGuessers, setCorrectGuessers] = useState<Set<string>>(
    new Set()
  );
  const [stillGuessing, setStillGuessing] = useState<Set<string>>(new Set());

  // Track when the current round started (timestamp)
  const [currentRoundStartedAt, setCurrentRoundStartedAt] = useState<
    string | null
  >(null);

  // Track words that have been used so far in this game
  const [usedWords, setUsedWords] = useState<Set<string>>(new Set());

  // Round-summary timer (5 s) and list of ordered correct guessers
  const [roundSummaryTimeLeft, setRoundSummaryTimeLeft] = useState(5);
  const [summaryPlayers, setSummaryPlayers] = useState<
    { user_id: string; username: string; gained: number }[]
  >([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Disable chat for the user who is currently drawing
  const isDrawer = user?.id === currentDrawer;
  const hasGuessedCorrectly = user?.id ? correctGuessers.has(user.id) : false;
  const chatDisabled =
    (isDrawer || hasGuessedCorrectly) && gameStatus === "playing";

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
      // Load previously used words from DB
      if (gameData.used_words && Array.isArray(gameData.used_words)) {
        setUsedWords(
          new Set(gameData.used_words.map((w: string) => w.toLowerCase()))
        );
      }

      // Calculate remaining time if game is in progress
      if (gameData.status === "playing" && gameData.round_started_at) {
        const startTime = new Date(gameData.round_started_at);
        const now = new Date();
        const elapsedSeconds = Math.floor(
          (now.getTime() - startTime.getTime()) / 1000
        );
        const remainingTime = Math.max(0, ROUND_DURATION - elapsedSeconds);

        setTimeLeft(remainingTime);
        setCurrentRoundStartedAt(gameData.round_started_at);

        // Auto-end round if timer already expired
        if (remainingTime <= 0) {
          endRound();
        }
      }

      // Calculate remaining time for word choice
      if (
        gameData.status === "choosing_word" &&
        gameData.word_choice_started_at
      ) {
        const startTime = new Date(gameData.word_choice_started_at);
        const now = new Date();
        const elapsedSeconds = Math.floor(
          (now.getTime() - startTime.getTime()) / 1000
        );
        const remainingTime = Math.max(0, 10 - elapsedSeconds);

        setWordChoiceTimeLeft(remainingTime);

        // Auto-select word if time expired and this client is the drawer
        if (
          remainingTime <= 0 &&
          user?.id === gameData.current_drawer &&
          wordChoices.length > 0
        ) {
          chooseWord(wordChoices[0]);
        }
      } else if (gameData.status !== "choosing_word") {
        // Reset word choice timer when not in choosing phase
        setWordChoiceTimeLeft(10);
      }

      // Calculate remaining time for round summary (5 seconds)
      if (
        (gameData.status as string) === "round_summary" &&
        gameData.round_started_at
      ) {
        const startTime = new Date(gameData.round_started_at);
        const now = new Date();
        const elapsedSeconds = Math.floor(
          (now.getTime() - startTime.getTime()) / 1000
        );
        const remainingTime = Math.max(0, 5 - elapsedSeconds);

        setRoundSummaryTimeLeft(remainingTime);
      }

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
          // update request received
          const updatedGame = payload.new as Game;
          setGame(updatedGame);
          setGameStatus(updatedGame.status);
          setCurrentDrawer(updatedGame.current_drawer ?? null);
          setCurrentWord(updatedGame.current_word || "");
          if (updatedGame.used_words && Array.isArray(updatedGame.used_words)) {
            setUsedWords(
              new Set(
                updatedGame.used_words.map((w: string) => w.toLowerCase())
              )
            );
          }

          if (updatedGame.status === "playing") {
            if (updatedGame.round_started_at) {
              // Calculate remaining time based on server timestamp
              const startTime = new Date(updatedGame.round_started_at);
              const now = new Date();
              const elapsedSeconds = Math.floor(
                (now.getTime() - startTime.getTime()) / 1000
              );
              const remainingTime = Math.max(
                0,
                ROUND_DURATION - elapsedSeconds
              );

              setTimeLeft(remainingTime);
              setCurrentRoundStartedAt(updatedGame.round_started_at);
            } else {
              // Fallback to ROUND_DURATION seconds if no timestamp available
              setTimeLeft(ROUND_DURATION);
            }
          } else if (updatedGame.status === "choosing_word") {
            if (updatedGame.word_choice_started_at) {
              // word choice started at
              // Calculate remaining time for word choice based on server timestamp
              const startTime = new Date(updatedGame.word_choice_started_at);
              const now = new Date();
              const elapsedSeconds = Math.floor(
                (now.getTime() - startTime.getTime()) / 1000
              );
              const remainingTime = Math.max(0, 10 - elapsedSeconds);

              setWordChoiceTimeLeft(remainingTime);
            } else {
              // Fallback to 10 seconds if no timestamp available
              setWordChoiceTimeLeft(10);
            }
          } else if ((updatedGame.status as string) === "round_summary") {
            // round summary started at
            if (updatedGame.round_started_at) {
              const startTime = new Date(updatedGame.round_started_at);
              const now = new Date();
              const elapsedSeconds = Math.floor(
                (now.getTime() - startTime.getTime()) / 1000
              );
              const remainingTime = Math.max(0, 5 - elapsedSeconds);

              setRoundSummaryTimeLeft(remainingTime);
            } else {
              setRoundSummaryTimeLeft(5);
            }
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
          event: "INSERT",
          schema: "public",
          table: "game_players",
          filter: `game_id=eq.${gameId}`,
        },
        (payload) => {
          const newPlayer = payload.new as GamePlayer;
          setPlayers((prev) => {
            if (prev.some((p) => p.id === newPlayer.id)) return prev;
            return [...prev, newPlayer];
          });
        }
      )
      // Listen for players leaving the game
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "game_players",
          filter: `game_id=eq.${gameId}`,
        },
        (payload) => {
          const leftId = (payload.old as GamePlayer).id;
          setPlayers((prev) => prev.filter((p) => p.id !== leftId));
        }
      )
      // Keep scores / name edits in sync
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "game_players",
          filter: `game_id=eq.${gameId}`,
        },
        () => {
          fetchGameData();
        }
      )
      .subscribe((status, err) => {
        // console.debug("game room channel", status, err);
      });

    return () => {
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

  // Word choice timer
  useEffect(() => {
    if (gameStatus === "choosing_word" && wordChoiceTimeLeft > 0) {
      const timer = setInterval(() => {
        setWordChoiceTimeLeft((prev) => {
          if (prev <= 1) {
            // Auto-select a word if the drawer is the current user
            if (user?.id === currentDrawer && wordChoices.length > 0) {
              // Choose the first word option
              chooseWord(wordChoices[0]);
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [gameStatus, wordChoiceTimeLeft, currentDrawer, user?.id, wordChoices]);

  // Round summary timer (5 seconds)
  useEffect(() => {
    if (gameStatus === "round_summary" && roundSummaryTimeLeft > 0) {
      const timer = setInterval(() => {
        setRoundSummaryTimeLeft((prev) => (prev <= 1 ? 0 : prev - 1));
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [gameStatus, roundSummaryTimeLeft]);

  // Auto transition out of round_summary when timer reaches 0 or already expired (handles page refresh)
  useEffect(() => {
    if (gameStatus !== "round_summary" || roundSummaryTimeLeft > 0) return;
    // round summary timer reached 0
    // Only one client needs to perform the update; do it optimistically
    (async () => {
      try {
        const wordChoiceTimestamp = new Date().toISOString();
        await supabase
          .from("games")
          .update({
            status: "choosing_word",
            round_started_at: null,
            word_choice_started_at: wordChoiceTimestamp,
          })
          .eq("id", gameId);
      } catch (err) {
        console.error(
          "Failed to transition from summary to choosing_word after refresh",
          err
        );
      }
    })();
  }, [gameStatus, roundSummaryTimeLeft, gameId]);

  // Build ordered list of players who guessed correctly at round end
  useEffect(() => {
    if (gameStatus !== "round_summary" || !currentRoundStartedAt) return;

    // 1) Correct guessers in the order they guessed
    const correctGuessMessages = messages
      .filter(
        (m) =>
          m.is_correct &&
          m.user_id &&
          new Date(m.created_at) >= new Date(currentRoundStartedAt)
      )
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

    const orderedSummary: {
      user_id: string;
      username: string;
      gained: number;
    }[] = correctGuessMessages.map((m) => {
      let gained = 0;
      if (currentRoundStartedAt) {
        const elapsed = Math.floor(
          (new Date(m.created_at).getTime() -
            new Date(currentRoundStartedAt).getTime()) /
            1000
        );
        if (elapsed <= 20) gained = 400;
        else if (elapsed <= 40) gained = 300;
        else if (elapsed <= 60) gained = 200;
        else gained = 100;
      }
      return {
        user_id: m.user_id!,
        username: m.username,
        gained,
      };
    });

    // 2) Add players who didn't guess (0 points), excluding the drawer
    players.forEach((player) => {
      if (
        player.user_id === currentDrawer ||
        orderedSummary.find((p) => p.user_id === player.user_id)
      ) {
        return;
      }
      orderedSummary.push({
        user_id: player.user_id,
        username: player.username,
        gained: 0,
      });
    });

    setSummaryPlayers(orderedSummary);
  }, [gameStatus, messages, currentRoundStartedAt, players, currentDrawer]);

  // Load words once on mount
  useEffect(() => {
    loadWordList().then(setWordList);
  }, []);

  // Keep track of words that have been used so far
  useEffect(() => {
    if (gameStatus === "playing" && currentWord) {
      setUsedWords((prev) => {
        if (prev.has(currentWord.toLowerCase())) return prev;
        return new Set([...prev, currentWord.toLowerCase()]);
      });
    }
  }, [gameStatus, currentWord]);

  const startGame = async () => {
    if (players.length < 2) {
      toast.error("Need at least 2 players to start the game");
      return;
    }

    try {
      const randomPlayer = players[Math.floor(Math.random() * players.length)];
      const timestamp = new Date().toISOString();

      const { error } = await supabase
        .from("games")
        .update({
          status: "choosing_word",
          current_word: "",
          current_drawer: randomPlayer.user_id,
          round: 1,
          word_choice_started_at: timestamp,
          used_words: [],
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
    // Clear the canvas for ALL clients by removing the strokes from the DB first
    try {
      await supabase.from("drawing_strokes").delete().eq("game_id", gameId);
    } catch (clrErr) {
      console.error("Failed to clear drawing_strokes at end of round", clrErr);
    }
    try {
      const nextRound = (game?.round || 1) + 1;
      const isGameFinished = nextRound > (game?.max_rounds || 5);

      if (isGameFinished) {
        await supabase
          .from("games")
          .update({
            status: "finished",
            round_started_at: null,
          })
          .eq("id", gameId);

        setGameStatus("finished");
        toast.success("Game finished!");
      } else {
        let remainingPlayers = players.filter(
          (p) => p.user_id !== currentDrawer
        );

        if (remainingPlayers.length === 0) {
          remainingPlayers = [...players];
        }

        if (remainingPlayers.length === 0) {
          console.warn("No available players to become the next drawer.");
          return;
        }

        const nextDrawer =
          remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];

        const summaryTimestamp = new Date().toISOString();

        // 1) Switch to round_summary phase so every client can display the board
        await supabase
          .from("games")
          .update({
            round: nextRound,
            current_word: "",
            current_drawer: nextDrawer.user_id,
            status: "round_summary",
            round_started_at: summaryTimestamp, // reuse column for summary start
            word_choice_started_at: null,
          })
          .eq("id", gameId);

        setCurrentDrawer(nextDrawer.user_id);
        setCurrentWord("");
        setGameStatus("round_summary");
        setRoundSummaryTimeLeft(5);

        // After 5 seconds, transition to choosing_word (only by client that triggered)
        setTimeout(async () => {
          try {
            const wordChoiceTimestamp = new Date().toISOString();
            await supabase
              .from("games")
              .update({
                status: "choosing_word",
                round_started_at: null,
                word_choice_started_at: wordChoiceTimestamp,
              })
              .eq("id", gameId);
          } catch (err) {
            console.error("Failed to move from summary to choosing_word", err);
          }
        }, 5000);

        // Reset guessing state for new round
        setCorrectGuessers(new Set());
        setStillGuessing(new Set());
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
      // Filter out words that have already been used in this game
      const available = wordList.filter((w) => !usedWords.has(w.toLowerCase()));

      // If fewer than 3 words remain, fall back to the full list (still without repeats)
      const source = available.length >= 3 ? available : wordList;

      const shuffled = [...source].sort(() => 0.5 - Math.random());
      // Ensure we don't include any used words in the final selection
      const choices = shuffled.filter((w) => !usedWords.has(w.toLowerCase()));
      setWordChoices(choices.slice(0, 3));
    }

    // Clean up choices when not needed
    if (gameStatus !== "choosing_word" && wordChoices.length > 0) {
      setWordChoices([]);
    }
  }, [
    gameStatus,
    currentDrawer,
    user,
    wordList,
    wordChoices.length,
    usedWords,
  ]);

  const chooseWord = async (word: string) => {
    try {
      // Create a timestamp for this round
      const timestamp = new Date().toISOString();

      const { error } = await supabase
        .from("games")
        .update({
          current_word: word,
          status: "playing",
          round_started_at: timestamp,
          used_words: [...(game?.used_words || []), word],
        })
        .eq("id", gameId);

      if (error) throw error;

      setCurrentWord(word);
      setGameStatus("playing");
      setWordChoices([]);
      setTimeLeft(ROUND_DURATION);
      // Mark this word as used locally
      setUsedWords((prev) => new Set([...prev, word.toLowerCase()]));

      // Set the round start timestamp
      setCurrentRoundStartedAt(timestamp);
      // console.log(`New round started at ${timestamp}`);
    } catch (error) {
      console.error("Error choosing word:", error);
      toast.error("Failed to choose word");
    }
  };

  const sendMessage = async () => {
    // Prevent the drawer from sending chat messages during their turn
    if (chatDisabled) return;
    if (!newMessage.trim()) return;

    try {
      const isGuess = gameStatus === "playing" && user?.id !== currentDrawer;
      const isCorrect =
        isGuess &&
        newMessage.toLowerCase().trim() === currentWord.toLowerCase();

      // If the guess is correct, we replace the actual guess with a generic success message
      const messageText = isCorrect
        ? `${user?.user_metadata?.username || "Anonymous"} guessed the word!`
        : newMessage;

      const { error } = await supabase.from("chat_messages").insert([
        {
          game_id: gameId,
          user_id: user?.id,
          username: user?.user_metadata?.username || "Anonymous",
          message: messageText,
          is_guess: isGuess,
          is_correct: isCorrect,
        },
      ]);

      if (error) throw error;

      if (isCorrect && user?.id) {
        toast.success("Correct guess!");

        // Determine points based on elapsed time since round start
        let gained = 0;
        if (currentRoundStartedAt) {
          const elapsed = Math.floor(
            (new Date().getTime() - new Date(currentRoundStartedAt).getTime()) /
              1000
          );
          if (elapsed <= 20) gained = 400;
          else if (elapsed <= 40) gained = 300;
          else if (elapsed <= 60) gained = 200;
          else gained = 100;
        } else {
          gained = 100;
        }

        // Update player score with dynamic points
        await supabase
          .from("game_players")
          .update({
            score:
              (players.find((p) => p.user_id === user?.id)?.score || 0) +
              gained,
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

  // Process correct guesses from messages for current round only
  useEffect(() => {
    if (gameStatus !== "playing" || !currentRoundStartedAt) return;

    // Create sets to track current state
    const currentCorrectGuessers = new Set(correctGuessers);
    const currentStillGuessing = new Set(stillGuessing);
    let stateChanged = false;

    // Find all correct guesses from the current round only
    const currentRoundMessages = messages.filter(
      (m) =>
        m.is_correct &&
        m.user_id &&
        new Date(m.created_at) >= new Date(currentRoundStartedAt)
    );

    // Process each correct guess from current round
    currentRoundMessages.forEach((message) => {
      if (message.user_id && currentStillGuessing.has(message.user_id)) {
        // Move player from stillGuessing to correctGuessers
        currentStillGuessing.delete(message.user_id);
        currentCorrectGuessers.add(message.user_id);
        stateChanged = true;
        // console.log(
        //   `Player ${message.user_id} guessed correctly in current round`
        // );
      }
    });

    // Update state only if changed (avoid unnecessary re-renders)
    if (stateChanged) {
      setCorrectGuessers(currentCorrectGuessers);
      setStillGuessing(currentStillGuessing);

      // console.log("Updated player tracking for current round:", {
      //   roundStartedAt: currentRoundStartedAt,
      //   correctGuessers: Array.from(currentCorrectGuessers),
      //   stillGuessing: Array.from(currentStillGuessing),
      // });
    }
  }, [
    messages,
    gameStatus,
    currentRoundStartedAt,
    correctGuessers,
    stillGuessing,
  ]);

  // Initialize player tracking state at the start of a new round
  useEffect(() => {
    if (gameStatus === "playing" && currentDrawer) {
      const newCorrectGuessers = new Set<string>();
      const newStillGuessing = new Set<string>();

      // Add the drawer to correct guessers (they already know the word)
      newCorrectGuessers.add(currentDrawer);

      // Add all other players to still guessing
      players.forEach((player) => {
        if (player.user_id !== currentDrawer) {
          newStillGuessing.add(player.user_id);
        }
      });

      setCorrectGuessers(newCorrectGuessers);
      setStillGuessing(newStillGuessing);

      // If the round start timestamp hasn't been set (e.g. when joining a game in progress)
      // Set it now to avoid processing old messages
      if (!currentRoundStartedAt) {
        setCurrentRoundStartedAt(new Date().toISOString());
      }
    }
  }, [gameStatus, currentDrawer, players, currentRoundStartedAt]);

  // Reset round timestamp when status changes from playing to choosing_word
  useEffect(() => {
    if (gameStatus === "choosing_word") {
      setCurrentRoundStartedAt(null);
      // console.log("Round timestamp reset for word choosing phase");
    }
  }, [gameStatus]);

  // Update player tracking when players join or leave
  useEffect(() => {
    if (gameStatus !== "playing") return;

    // Get current player IDs
    const currentPlayerIds = new Set(players.map((p) => p.user_id));

    // For tracking changes
    let stateChanged = false;
    const updatedCorrectGuessers = new Set(correctGuessers);
    const updatedStillGuessing = new Set(stillGuessing);

    // Handle players who left (remove from tracking)
    Array.from(updatedCorrectGuessers).forEach((id) => {
      if (!currentPlayerIds.has(id)) {
        updatedCorrectGuessers.delete(id);
        // console.log(`Player ${id} left and was removed from correctGuessers`);
        stateChanged = true;
      }
    });

    Array.from(updatedStillGuessing).forEach((id) => {
      if (!currentPlayerIds.has(id)) {
        updatedStillGuessing.delete(id);
        // console.log(`Player ${id} left and was removed from stillGuessing`);
        stateChanged = true;
      }
    });

    // Handle new players who joined during the game (add to stillGuessing)
    players.forEach((player) => {
      const id = player.user_id;
      if (
        id !== currentDrawer &&
        !updatedCorrectGuessers.has(id) &&
        !updatedStillGuessing.has(id)
      ) {
        updatedStillGuessing.add(id);
        // console.log(`New player ${id} joined and added to stillGuessing`);
        stateChanged = true;
      }
    });

    // Update state if needed
    if (stateChanged) {
      setCorrectGuessers(updatedCorrectGuessers);
      setStillGuessing(updatedStillGuessing);

      // console.log("Player tracking updated after join/leave:", {
      //   correctGuessers: Array.from(updatedCorrectGuessers),
      //   stillGuessing: Array.from(updatedStillGuessing),
      //   totalPlayers: players.length,
      // });
    }
  }, [players, gameStatus, currentDrawer]);

  // End round when everyone has guessed correctly
  useEffect(() => {
    if (gameStatus !== "playing") return;

    // If no one is still guessing, end the round
    if (stillGuessing.size === 0 && correctGuessers.size > 1) {
      // At least drawer + 1 guesser
      // console.log("Everyone guessed correctly - ending round", {
      //   correctGuessers: Array.from(correctGuessers),
      //   stillGuessing: Array.from(stillGuessing),
      // });
      endRound();
    }
  }, [stillGuessing.size, correctGuessers.size, gameStatus]);

  // Helper to leave game room and clean up player's entry
  const leaveGame = async () => {
    if (!gameId || !user?.id) {
      navigate("/lobby");
      return;
    }
    try {
      await supabase
        .from("game_players")
        .delete()
        .eq("game_id", gameId)
        .eq("user_id", user.id);
    } catch (err) {
      console.error("Error leaving game:", err);
    } finally {
      navigate("/lobby");
    }
  };

  // End game automatically if player count drops below 2 after the game has started
  useEffect(() => {
    if (!gameId) return;
    if (
      players.length <= 1 &&
      ["choosing_word", "playing", "round_summary"].includes(gameStatus)
    ) {
      (async () => {
        try {
          await supabase
            .from("games")
            .update({ status: "finished" })
            .eq("id", gameId);
          setGameStatus("finished");
        } catch (err) {
          console.error("Error auto-ending game:", err);
        }
      })();
    }
  }, [players.length, gameStatus, gameId]);

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
                onClick={leaveGame}
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
                        : gameStatus === "playing" &&
                          correctGuessers.has(player.user_id)
                        ? "bg-green-50 border border-green-200"
                        : "bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                      <span className="font-medium">{player.username}</span>
                      {player.user_id === user?.id && (
                        <span className="text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded">
                          You
                        </span>
                      )}
                      {player.user_id === currentDrawer && (
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                          Drawing
                        </span>
                      )}
                      {gameStatus === "playing" &&
                        player.user_id !== currentDrawer &&
                        correctGuessers.has(player.user_id) && (
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                            Guessed
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
                  {players.length >= 2 && (
                    <button
                      onClick={startGame}
                      className="px-6 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors animate-pulse"
                    >
                      Start Game
                    </button>
                  )}
                  {players.length < 2 && (
                    <p className="text-gray-500 text-sm">
                      Need at least 2 players to start
                    </p>
                  )}
                </div>
              ) : gameStatus === "choosing_word" ? (
                <div className="text-center py-12">
                  {user?.id === currentDrawer ? (
                    <div>
                      <h3 className="text-xl font-semibold mb-2">
                        Choose a word
                      </h3>
                      <p className="text-sm text-gray-600 mb-4">
                        Time remaining:{" "}
                        <span className="font-bold text-blue-600">
                          {wordChoiceTimeLeft}s
                        </span>
                      </p>
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
                    <div>
                      <p className="text-gray-600 mb-2">
                        Waiting for the drawer to choose a word...
                      </p>
                      <p className="text-sm text-gray-500">
                        Time remaining:{" "}
                        <span className="font-semibold">
                          {wordChoiceTimeLeft}s
                        </span>
                      </p>
                    </div>
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
                        <p className="text-center text-sm text-blue-600 mt-1">
                          {Math.max(
                            0,
                            correctGuessers.has(currentDrawer ?? "")
                              ? correctGuessers.size - 1
                              : correctGuessers.size
                          )}{" "}
                          of {players.length - 1} players have guessed correctly
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
                          {correctGuessers.has(user?.id || "")
                            ? currentWord
                            : currentWord
                                .split("")
                                .map(() => "_")
                                .join(" ")}
                        </p>
                        <p className="text-sm text-gray-600 mt-1">
                          {Math.max(
                            0,
                            correctGuessers.has(currentDrawer ?? "")
                              ? correctGuessers.size - 1
                              : correctGuessers.size
                          )}{" "}
                          of {players.length - 1} players have guessed correctly
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
              ) : gameStatus === "round_summary" ? (
                <div className="text-center py-12">
                  <h3 className="text-xl font-semibold mb-2">Round Summary</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Next round starts in {roundSummaryTimeLeft}s
                  </p>
                  <div className="space-y-2">
                    {summaryPlayers.map((player, index) => (
                      <div
                        key={player.user_id}
                        className="flex items-center justify-between p-2 bg-gray-50 rounded"
                      >
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold">#{index + 1}</span>
                          <span>{player.username}</span>
                        </div>
                        <span className="font-semibold">
                          {player.gained} points
                        </span>
                      </div>
                    ))}
                  </div>
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
                    placeholder={
                      chatDisabled
                        ? isDrawer
                          ? "You can't chat while drawing"
                          : "You can't chat after guessing correctly"
                        : "Type your message..."
                    }
                    disabled={chatDisabled}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={chatDisabled}
                    className={`px-4 py-2 rounded-md transition-colors ${
                      chatDisabled
                        ? "bg-gray-300 cursor-not-allowed"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
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
