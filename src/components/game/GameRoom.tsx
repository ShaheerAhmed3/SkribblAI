import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, Game, GamePlayer, ChatMessage } from "../../lib/supabase";
import { Home, Send, Brush, ArrowLeft } from "lucide-react";
import toast from "react-hot-toast";
import DrawingCanvas from "./DrawingCanvas";
import { loadWordList } from "../../lib/wordList";

// Utility function to calculate score based on dynamic quarter intervals
const calculateScore = (
  elapsedSeconds: number,
  roundDuration: number
): number => {
  const quarterDuration = roundDuration / 4;

  if (elapsedSeconds <= quarterDuration) return 400; // First quarter
  if (elapsedSeconds <= quarterDuration * 2) return 300; // Second quarter
  if (elapsedSeconds <= quarterDuration * 3) return 200; // Third quarter
  return 100; // Fourth quarter
};

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
  const [timeLeft, setTimeLeft] = useState(80); // Will be updated when game data loads
  const [wordChoiceTimeLeft, setWordChoiceTimeLeft] = useState(10);
  const [gameStatus, setGameStatus] = useState<
    "waiting" | "choosing_word" | "playing" | "round_summary" | "finished"
  >("waiting");

  const [wordList, setWordList] = useState<string[]>([]);
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  const [correctGuessers, setCorrectGuessers] = useState<Set<string>>(
    new Set()
  );
  const [stillGuessing, setStillGuessing] = useState<Set<string>>(new Set());

  const [currentRoundStartedAt, setCurrentRoundStartedAt] = useState<
    string | null
  >(null);

  const [usedWords, setUsedWords] = useState<Set<string>>(new Set());

  const [roundSummaryTimeLeft, setRoundSummaryTimeLeft] = useState(5);
  const [summaryPlayers, setSummaryPlayers] = useState<
    { user_id: string; username: string; gained: number }[]
  >([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const isDrawer = user?.id === currentDrawer;
  const hasGuessedCorrectly = user?.id ? correctGuessers.has(user.id) : false;
  const chatDisabled =
    (isDrawer || hasGuessedCorrectly) && gameStatus === "playing";

  // Calculate current showdown based on round and player count
  const getCurrentShowdown = useCallback(() => {
    if (!game || !players.length) return { current: 1, total: 1 };

    const playersInGame = players.length;
    const currentRound = game.round;
    const totalShowdowns = game.showdowns || 3;

    // Calculate which showdown we're in (1-indexed)
    const currentShowdown = Math.ceil(currentRound / playersInGame);

    return {
      current: Math.min(currentShowdown, totalShowdowns),
      total: totalShowdowns,
    };
  }, [game, players]);

  const currentShowdownInfo = getCurrentShowdown();

  // Calculate round within current showdown for display
  const getRoundInShowdown = useCallback(() => {
    if (!game || !players.length) return { current: 1, total: 1 };

    const playersInGame = players.length;
    const currentRound = game.round;

    // Calculate which round within the current showdown (1-indexed)
    const roundInShowdown = ((currentRound - 1) % playersInGame) + 1;

    return {
      current: roundInShowdown,
      total: playersInGame,
    };
  }, [game, players]);

  const roundInShowdownInfo = getRoundInShowdown();

  // Calculate next drawer in round-robin fashion for showdowns
  const getNextDrawer = useCallback(() => {
    if (!game || !players.length) return null;

    // Sort players by join order for consistent round-robin
    const sortedPlayers = [...players].sort(
      (a, b) =>
        new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
    );

    const nextRound = (game.round || 1) + 1;
    const playersInGame = sortedPlayers.length;

    // Calculate which player should draw next (0-indexed within the showdown)
    const playerIndexInShowdown = (nextRound - 1) % playersInGame;

    return sortedPlayers[playerIndexInShowdown];
  }, [game, players]);

  //Fetches the latest game, player and message data from Supabase
  //and synchronises the component state accordingly.
  const fetchGameData = useCallback(async () => {
    if (!gameId) return;
    try {
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
      if (gameData.used_words && Array.isArray(gameData.used_words)) {
        setUsedWords(
          new Set(gameData.used_words.map((w: string) => w.toLowerCase()))
        );
      }

      if (gameData.status === "playing" && gameData.round_started_at) {
        const startTime = new Date(gameData.round_started_at);
        const now = new Date();
        const elapsedSeconds = Math.floor(
          (now.getTime() - startTime.getTime()) / 1000
        );
        const remainingTime = Math.max(
          0,
          (gameData.round_duration || 80) - elapsedSeconds
        );

        setTimeLeft(remainingTime);
        setCurrentRoundStartedAt(gameData.round_started_at);

        if (remainingTime <= 0) {
          endRound();
        }
      }

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
        if (
          remainingTime <= 0 &&
          user?.id === gameData.current_drawer &&
          wordChoices.length > 0
        ) {
          chooseWord(wordChoices[0]);
        }
      } else if (gameData.status !== "choosing_word") {
        setWordChoiceTimeLeft(10);
      }

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

      const { data: playersData, error: playersError } = await supabase
        .from("game_players")
        .select("*")
        .eq("game_id", gameId);

      if (playersError) throw playersError;
      setPlayers(playersData || []);

      const { data: messagesData, error: messagesError } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("game_id", gameId)
        .order("created_at", { ascending: true });

      if (messagesError) throw messagesError;
      setMessages(messagesData || []);

      // Allow players to rejoin during any game state (not just "waiting")
      const isPlayerInGame = playersData?.some((p) => p.user_id === user?.id);
      if (!isPlayerInGame && gameData.status !== "finished") {
        // Try to restore the player using upsert to handle potential race conditions
        await supabase.from("game_players").upsert(
          [
            {
              game_id: gameId,
              user_id: user?.id,
              username: user?.user_metadata?.username || "Anonymous",
              score: 0, // Will be preserved if player already exists
              is_drawing: false,
            },
          ],
          {
            onConflict: "game_id,user_id",
            ignoreDuplicates: true,
          }
        );
      }
    } catch (error) {
      toast.error("Failed to load game");
    } finally {
      setLoading(false);
    }
  }, [gameId, user]);

  // Subscribe to Realtime changes (only once per room)
  useEffect(() => {
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
              const startTime = new Date(updatedGame.round_started_at);
              const now = new Date();
              const elapsedSeconds = Math.floor(
                (now.getTime() - startTime.getTime()) / 1000
              );
              const remainingTime = Math.max(
                0,
                (updatedGame.round_duration || 80) - elapsedSeconds
              );

              setTimeLeft(remainingTime);
              setCurrentRoundStartedAt(updatedGame.round_started_at);
            } else {
              setTimeLeft(updatedGame.round_duration || 80);
            }
          } else if (updatedGame.status === "choosing_word") {
            if (updatedGame.word_choice_started_at) {
              const startTime = new Date(updatedGame.word_choice_started_at);
              const now = new Date();
              const elapsedSeconds = Math.floor(
                (now.getTime() - startTime.getTime()) / 1000
              );
              const remainingTime = Math.max(0, 10 - elapsedSeconds);

              setWordChoiceTimeLeft(remainingTime);
            } else {
              setWordChoiceTimeLeft(10);
            }
          } else if ((updatedGame.status as string) === "round_summary") {
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
            if (prev.some((p) => p.user_id === newPlayer.user_id)) return prev;
            return [...prev, newPlayer];
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "game_players",
          filter: `game_id=eq.${gameId}`,
        },
        (payload) => {
          const leftUserId = (payload.old as GamePlayer).user_id;
          setPlayers((prev) => prev.filter((p) => p.user_id !== leftUserId));
        }
      )
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
      .subscribe((status, err) => {});

    return () => {
      supabase.removeChannel(channel);
    };
  }, [gameId, user?.id, authLoading]);

  //Fetch game data on mount
  useEffect(() => {
    if (!gameId) return;
    fetchGameData();
  }, [gameId, user, fetchGameData]);

  //Drawing round timer
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

  //Word choice timer
  useEffect(() => {
    if (gameStatus === "choosing_word" && wordChoiceTimeLeft > 0) {
      const timer = setInterval(() => {
        setWordChoiceTimeLeft((prev) => {
          if (prev <= 1) {
            if (user?.id === currentDrawer && wordChoices.length > 0) {
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

  //Round summary timer
  useEffect(() => {
    if (gameStatus === "round_summary" && roundSummaryTimeLeft > 0) {
      const timer = setInterval(() => {
        setRoundSummaryTimeLeft((prev) => (prev <= 1 ? 0 : prev - 1));
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [gameStatus, roundSummaryTimeLeft]);

  //Auto transition out of round_summary when timer reaches 0 or already expired (handles page refresh)
  useEffect(() => {
    if (gameStatus !== "round_summary" || roundSummaryTimeLeft > 0) return;
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
      } catch {}
    })();
  }, [gameStatus, roundSummaryTimeLeft, gameId]);

  //Build ordered list of players who guessed correctly at round end
  useEffect(() => {
    if (gameStatus !== "round_summary" || !currentRoundStartedAt) return;

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
      if (currentRoundStartedAt && game?.round_duration) {
        const elapsed = Math.floor(
          (new Date(m.created_at).getTime() -
            new Date(currentRoundStartedAt).getTime()) /
            1000
        );
        gained = calculateScore(elapsed, game.round_duration);
      }
      return {
        user_id: m.user_id!,
        username: m.username,
        gained,
      };
    });

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

  //Load words once on mount
  useEffect(() => {
    loadWordList().then(setWordList);
  }, []);

  //Mark this word as used locally
  useEffect(() => {
    if (gameStatus === "playing" && currentWord) {
      setUsedWords((prev) => {
        if (prev.has(currentWord.toLowerCase())) return prev;
        return new Set([...prev, currentWord.toLowerCase()]);
      });
    }
  }, [gameStatus, currentWord]);

  //Transitions the game from the waiting lobby to the first word-selection phase.
  const startGame = async () => {
    if (players.length < 2) {
      toast.error("Need at least 2 players to start the game");
      return;
    }

    try {
      // Use first player in sorted order to start first showdown
      const sortedPlayers = [...players].sort(
        (a, b) =>
          new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
      );
      const firstPlayer = sortedPlayers[0];
      const timestamp = new Date().toISOString();

      // Calculate total rounds: showdowns × actual players in game
      const totalRounds = (game?.showdowns || 3) * players.length;

      const { error } = await supabase
        .from("games")
        .update({
          status: "choosing_word",
          current_word: "",
          current_drawer: firstPlayer.user_id,
          round: 1,
          max_rounds: totalRounds, // Set based on actual players
          word_choice_started_at: timestamp,
          used_words: [],
        })
        .eq("id", gameId);

      if (error) throw error;

      setGameStatus("choosing_word");
      setCurrentWord("");
      setCurrentDrawer(firstPlayer.user_id);
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  //Ends the current drawing round, shows the summary for 5 s and
  //either starts the next word-choice phase or finishes the game.
  const endRound = async () => {
    try {
      await supabase.from("drawing_strokes").delete().eq("game_id", gameId);
    } catch {}
    try {
      const nextRound = (game?.round || 1) + 1;
      const isGameFinished = nextRound > (game?.max_rounds || 15);

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
        // Use round-robin selection for proper showdown progression
        const nextDrawer = getNextDrawer();

        if (!nextDrawer) {
          toast.error("Unable to determine next drawer");
          return;
        }

        const summaryTimestamp = new Date().toISOString();

        await supabase
          .from("games")
          .update({
            round: nextRound,
            current_drawer: nextDrawer.user_id,
            status: "round_summary",
            round_started_at: summaryTimestamp,
            word_choice_started_at: null,
          })
          .eq("id", gameId);

        setCurrentDrawer(nextDrawer.user_id);
        setGameStatus("round_summary");
        setRoundSummaryTimeLeft(5);
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
          } catch {}
        }, 5000);

        setCorrectGuessers(new Set());
        setStillGuessing(new Set());
      }
    } catch (error: any) {
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
      const available = wordList.filter((w) => !usedWords.has(w.toLowerCase()));
      const source = available.length >= 3 ? available : wordList;
      const shuffled = [...source].sort(() => 0.5 - Math.random());
      const choices = shuffled.filter((w) => !usedWords.has(w.toLowerCase()));
      setWordChoices(choices.slice(0, 3));
    }
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

  //Drawer selects a word → updates DB, starts the playing phase & timer.
  const chooseWord = async (word: string) => {
    try {
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
      setTimeLeft(game?.round_duration || 80);
      setUsedWords((prev) => new Set([...prev, word.toLowerCase()]));

      setCurrentRoundStartedAt(timestamp);
    } catch (error) {
      toast.error("Failed to choose word");
    }
  };

  //Sends a chat message (or guess) to Supabase and awards points for correct guesses.
  const sendMessage = async () => {
    if (chatDisabled) return;
    if (!newMessage.trim()) return;

    try {
      const isGuess = gameStatus === "playing" && user?.id !== currentDrawer;
      const isCorrect =
        isGuess &&
        newMessage.toLowerCase().trim() === currentWord.toLowerCase();

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

        let gained = 0;
        if (currentRoundStartedAt && game?.round_duration) {
          const elapsed = Math.floor(
            (new Date().getTime() - new Date(currentRoundStartedAt).getTime()) /
              1000
          );
          gained = calculateScore(elapsed, game.round_duration);
        } else {
          gained = 100;
        }

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
      toast.error(error.message);
    }
  };

  //Process correct guesses from messages for current round only
  useEffect(() => {
    if (gameStatus !== "playing" || !currentRoundStartedAt) return;

    const currentCorrectGuessers = new Set(correctGuessers);
    const currentStillGuessing = new Set(stillGuessing);
    let stateChanged = false;

    const currentRoundMessages = messages.filter(
      (m) =>
        m.is_correct &&
        m.user_id &&
        new Date(m.created_at) >= new Date(currentRoundStartedAt)
    );

    currentRoundMessages.forEach((message) => {
      if (message.user_id && currentStillGuessing.has(message.user_id)) {
        currentStillGuessing.delete(message.user_id);
        currentCorrectGuessers.add(message.user_id);
        stateChanged = true;
      }
    });

    if (stateChanged) {
      setCorrectGuessers(currentCorrectGuessers);
      setStillGuessing(currentStillGuessing);
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
      newCorrectGuessers.add(currentDrawer);
      players.forEach((player) => {
        if (player.user_id !== currentDrawer) {
          newStillGuessing.add(player.user_id);
        }
      });

      setCorrectGuessers(newCorrectGuessers);
      setStillGuessing(newStillGuessing);
      if (!currentRoundStartedAt) {
        setCurrentRoundStartedAt(new Date().toISOString());
      }
    }
  }, [gameStatus, currentDrawer, players, currentRoundStartedAt]);

  // Reset round timestamp when status changes from playing to choosing_word
  useEffect(() => {
    if (gameStatus === "choosing_word") {
      setCurrentRoundStartedAt(null);
    }
  }, [gameStatus]);

  // Update player tracking when players join or leave
  useEffect(() => {
    if (gameStatus !== "playing") return;
    const currentPlayerIds = new Set(players.map((p) => p.user_id));
    let stateChanged = false;
    const updatedCorrectGuessers = new Set(correctGuessers);
    const updatedStillGuessing = new Set(stillGuessing);
    Array.from(updatedCorrectGuessers).forEach((id) => {
      if (!currentPlayerIds.has(id)) {
        updatedCorrectGuessers.delete(id);
        stateChanged = true;
      }
    });
    Array.from(updatedStillGuessing).forEach((id) => {
      if (!currentPlayerIds.has(id)) {
        updatedStillGuessing.delete(id);
        stateChanged = true;
      }
    });
    players.forEach((player) => {
      const id = player.user_id;
      if (
        id !== currentDrawer &&
        !updatedCorrectGuessers.has(id) &&
        !updatedStillGuessing.has(id)
      ) {
        updatedStillGuessing.add(id);
        stateChanged = true;
      }
    });
    if (stateChanged) {
      setCorrectGuessers(updatedCorrectGuessers);
      setStillGuessing(updatedStillGuessing);
    }
  }, [players, gameStatus, currentDrawer]);

  // End round when everyone has guessed correctly
  useEffect(() => {
    if (gameStatus !== "playing") return;
    if (stillGuessing.size === 0 && correctGuessers.size > 1) {
      endRound();
    }
  }, [stillGuessing.size, correctGuessers.size, gameStatus]);

  //Removes the current user from the game and navigates back to the lobby.
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
    } catch {
    } finally {
      navigate("/lobby");
    }
  };

  // End game automatically if player count drops below 2 after the game has started
  // Use a delay to prevent premature ending due to temporary disconnections (like refreshes)
  useEffect(() => {
    if (!gameId) return;
    if (loading) return; // Wait until initial data is fully loaded
    if (
      players.length <= 1 &&
      ["choosing_word", "playing", "round_summary"].includes(gameStatus)
    ) {
      // Add a 3-second delay to handle temporary disconnections/refreshes
      const timeoutId = setTimeout(async () => {
        // Double-check the player count after the delay
        try {
          const { data: currentPlayersData } = await supabase
            .from("game_players")
            .select("*")
            .eq("game_id", gameId);

          // Only end the game if player count is still low after the delay
          if (currentPlayersData && currentPlayersData.length <= 1) {
            await supabase
              .from("games")
              .update({ status: "finished" })
              .eq("id", gameId);
            setGameStatus("finished");
          }
        } catch (error) {
          console.error("Error checking player count:", error);
        }
      }, 3000); // 3-second delay

      return () => clearTimeout(timeoutId);
    }
  }, [players, gameStatus, gameId, loading]);

  // Automatically scroll chat container, not whole page, to latest message
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

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
    <div
      className="min-h-screen bg-indigo-50"
      style={{
        backgroundImage: "url(/static/image3.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }}
    >
      {/* Header */}
      <div className="bg-white shadow-md border-2 border-black">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={leaveGame}
                className="flex items-center space-x-2 px-3 py-2 border-2 border-black rounded-md text-indigo-600 hover:text-purple-700 hover:bg-gray-50 transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
                <Home className="h-8 w-8" />
              </button>
              <div>
                <h1 className="text-xl font-semibold">Room: {game.name}</h1>
              </div>
            </div>
            <div className="flex items-center space-x-6">
              <div className="text-right">
                <p className="text-sm text-gray-600">
                  Showdown {currentShowdownInfo.current}/
                  {currentShowdownInfo.total} • Round{" "}
                  {roundInShowdownInfo.current}/{roundInShowdownInfo.total} •{" "}
                  {players.length} players
                </p>
              </div>
              {gameStatus === "playing" && (
                <div className="text-center">
                  <div className="text-2xl font-extrabold text-indigo-600">
                    {timeLeft}s
                  </div>
                  <div className="text-sm text-gray-600">Time remaining</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Players List */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-sm p-4 border-2 border-black">
              <h3 className="font-semibold mb-4">Players</h3>
              <div className="space-y-2">
                {[...players]
                  .sort((a, b) => {
                    // Sort by score (highest first), then by join time (earliest first) for stable ordering
                    if (a.score !== b.score) {
                      return b.score - a.score; // Higher score first
                    }
                    return (
                      new Date(a.joined_at).getTime() -
                      new Date(b.joined_at).getTime()
                    ); // Earlier join time first
                  })
                  .map((player) => (
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
                          <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded flex items-center">
                            <Brush className="h-3 w-3" />
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
          <div className="lg:col-span-3">
            <div className="bg-white rounded-lg shadow-sm p-4 border-2 border-black">
              {gameStatus === "waiting" ? (
                <div className="text-center py-12">
                  <h3 className="text-xl font-semibold mb-4">
                    {players.length >= 1
                      ? "Ready to start?"
                      : "Waiting for players..."}
                  </h3>
                  <p className="text-gray-600 mb-6">
                    {players.length}/{game?.max_players || 6} player
                    {players.length !== 1 ? "s" : ""} joined
                  </p>
                  {players.length >= 2 && (
                    <button
                      onClick={startGame}
                      className="px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-md shadow-lg hover:from-indigo-600 hover:to-purple-700 transition-all duration-300"
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
                  <p className="text-lg font-medium text-gray-800 mb-2">
                    Word was:{" "}
                    <span className="font-semibold">{currentWord}</span>
                  </p>
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
                          + {player.gained} points
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
            <div className="bg-white rounded-lg shadow-sm h-96 flex flex-col border-2 border-black">
              <div className="p-4 border-b">
                <h3 className="font-semibold">Chat</h3>
              </div>

              <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto p-4 space-y-2"
              >
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
                          ? ""
                          : ""
                        : "Type your message..."
                    }
                    disabled={chatDisabled}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 min-w-0"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={chatDisabled}
                    className={`px-4 py-2 flex items-center justify-center rounded-md transition-all duration-300 shadow-md ${
                      chatDisabled
                        ? "bg-gray-300 cursor-not-allowed"
                        : "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700"
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
