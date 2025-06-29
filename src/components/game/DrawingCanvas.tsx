import React, { useRef, useEffect, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import * as fabric from "fabric";
import { RealtimeChannel } from "@supabase/supabase-js";

interface DrawingCanvasProps {
  gameId: string;
  readOnly?: boolean;
  currentDrawerId: string | null;
}

const DrawingCanvas: React.FC<DrawingCanvasProps> = ({
  gameId,
  readOnly = false,
  currentDrawerId,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<fabric.Canvas | null>(null);
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const prevDrawerIdRef = useRef<string | null>(null);
  const [selectedColor, setSelectedColor] = useState("#000000");
  const [brushSize, setBrushSize] = useState(5);
  const [currentTool, setCurrentTool] = useState<"brush" | "eraser">("brush");
  const [sizeDropdownOpen, setSizeDropdownOpen] = useState(false);
  const sizeDropdownRef = useRef<HTMLDivElement>(null);
  const prevCanvasWidthRef = useRef<number | null>(null);
  const liveChannelRef = useRef<RealtimeChannel | null>(null);
  const currentPathIdRef = useRef<string | null>(null);
  const lastLiveSendRef = useRef<number>(0);
  const remotePathMapRef = useRef<
    Record<string, { lastX: number; lastY: number }>
  >({});

  const remoteLinesMapRef = useRef<Record<string, fabric.Object[]>>({});

  const palette = [
    // Row 1
    "#C1C1C1",
    "#EF130B",
    "#FF7100",
    "#FFF400",
    "#00CC00",
    "#00B2FF",
    "#231FD3",
    "#A300BA",
    "#D37CAA",
    "#A0522D",
    "#00FFD0",
    // Row 2
    "#000000",
    "#5B5B5B",
    "#740B07",
    "#C23800",
    "#C2A300",
    "#007500",
    "#0066C2",
    "#120E81",
    "#640078",
    "#A0245E",
    "#63300D",
  ];

  const sizeOptions = [2, 4, 6, 10, 16, 24];
  useEffect(() => {
    if (!canvasRef.current) {
      return;
    }

    const container = canvasRef.current.parentElement;
    if (!container) {
      return;
    }

    const width = container.clientWidth;
    const height = width * 0.75; // 4:3 aspect ratio

    // Create Fabric canvas
    const canvas = new fabric.Canvas(canvasRef.current, {
      isDrawingMode: !readOnly,
      backgroundColor: "white",
      width: width,
      height: height,
      selection: false,
      enableRetinaScaling: false,
    });

    // Store canvas reference
    fabricCanvasRef.current = canvas;

    // Store initial width for future scaling
    prevCanvasWidthRef.current = width;

    // Set loading state to false
    setIsLoading(false);

    // Set up brush
    const brush = new fabric.PencilBrush(canvas);
    brush.color = selectedColor;
    brush.width = brushSize;
    canvas.freeDrawingBrush = brush;

    // Further disable object interaction/selection
    // @ts-ignore - fabric Canvas has these props at runtime
    canvas.interactive = false;
    canvas.skipTargetFind = true;

    // Handle resize
    const handleResize = () => {
      const newWidth = container.clientWidth;
      const prevWidth = prevCanvasWidthRef.current ?? newWidth;
      if (newWidth === prevWidth) return;

      const scale = newWidth / prevWidth;
      const newHeight = newWidth * 0.75;

      // Scale all objects proportionally
      canvas.getObjects().forEach((obj: any) => {
        obj.scaleX *= scale;
        obj.scaleY *= scale;
        obj.left *= scale;
        obj.top *= scale;
        obj.setCoords();
      });

      // Update canvas dimensions
      canvas.setWidth(newWidth);
      canvas.setHeight(newHeight);

      // Rerender canvas
      canvas.renderAll();

      // Update stored width for next resize
      prevCanvasWidthRef.current = newWidth;
    };

    window.addEventListener("resize", handleResize);

    // Clean up on unmount
    return () => {
      window.removeEventListener("resize", handleResize);
      canvas.dispose();
    };
  }, [readOnly]);

  // Helper to clear local canvas and load all strokes from DB
  const fetchAndRenderStrokes = async () => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    // Clear existing objects
    canvas.clear();
    canvas.backgroundColor = "white";

    const { data, error } = await supabase
      .from("drawing_strokes")
      .select("*")
      .eq("game_id", gameId);

    if (error) {
      console.error("Error fetching strokes:", error);
      return;
    }

    if (data) {
      for (const stroke of data) {
        await addStrokeToCanvas(stroke);
      }
    }
  };

  // Function to add a stroke to the canvas
  async function addStrokeToCanvas(stroke: any) {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    // Skip deprecated fill strokes
    if (stroke.tool === "fill") {
      return;
    }

    const pathData = stroke.points;
    const path = await fabric.Path.fromObject(pathData);
    if (path) {
      path.selectable = false;
      path.evented = false;
      canvas.add(path);
      canvas.renderAll();
    }
  }

  // Load existing strokes and subscribe to updates
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!gameId || !canvas) return;

    fetchAndRenderStrokes();

    // Subscribe to real-time drawing updates
    const subscription = supabase
      .channel(`drawing:${gameId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "drawing_strokes",
          filter: `game_id=eq.${gameId}`,
        },
        (payload) => {
          addStrokeToCanvas(payload.new);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "drawing_strokes",
          filter: `game_id=eq.${gameId}`,
        },
        () => {
          // Received a delete event, clear the local canvas
          const canvas = fabricCanvasRef.current;
          if (canvas) {
            canvas.clear();
            canvas.backgroundColor = "white";
            canvas.renderAll();
            // After any delete (single undo or full clear) reload remaining strokes
            fetchAndRenderStrokes();
          }
        }
      )
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR") {
          console.error("strokes channel error", err);
        }
      });

    // Clean up subscription on unmount
    return () => {
      subscription.unsubscribe();
    };
  }, [gameId]);

  // Clear canvas only when the drawer really changes (skip null→id on first load)

  // Save path to database when drawn
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || readOnly) return;

    const handlePathCreated = (opt: any) => {
      const path = opt.path;
      if (!path) return;

      // Make the path non-selectable and non-interactive
      path.selectable = false;
      path.evented = false;

      // Convert path to JSON
      const pathData = path.toJSON();

      // Save path to database
      savePath(pathData);
    };

    // Add event listener
    canvas.on("path:created", handlePathCreated);

    // Clean up event listener on unmount
    return () => {
      canvas.off("path:created", handlePathCreated);
    };
  }, [readOnly, gameId]);

  // Update brush/eraser properties
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    canvas.isDrawingMode = !readOnly;

    if (!canvas.freeDrawingBrush) return;

    const brush = canvas.freeDrawingBrush as fabric.PencilBrush;

    if (currentTool === "eraser") {
      brush.color = "#FFFFFF";
      brush.width = brushSize * 1.5;
    } else if (currentTool === "brush") {
      brush.color = selectedColor;
      brush.width = brushSize;
    }
  }, [selectedColor, brushSize, currentTool, readOnly]);

  // Save path to database
  const savePath = async (pathData: any) => {
    if (!user) return;
    try {
      const { error } = await supabase.from("drawing_strokes").insert([
        {
          game_id: gameId,
          points: pathData,
          color: currentTool === "eraser" ? "#FFFFFF" : selectedColor,
          brush_size: currentTool === "eraser" ? brushSize * 1.5 : brushSize,
          tool: currentTool,
        },
      ]);

      if (error) throw error;
    } catch (error) {
      console.error("Error saving path:", error);
    }
  };

  const clearCanvas = async () => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    // Always clear the local canvas for immediate feedback
    canvas.clear();
    canvas.backgroundColor = "white";
    canvas.renderAll();

    // Only the current drawer has permission to delete from the DB
    if (user?.id === currentDrawerId) {
      try {
        await supabase.from("drawing_strokes").delete().eq("game_id", gameId);
        // In clearCanvas function, add broadcast to notify viewers
        liveChannelRef.current?.send({
          type: "broadcast",
          event: "canvas_clear",
          payload: { drawerId: user.id },
        });
        fetchAndRenderStrokes();
      } catch (error) {
        console.error("Error in clearCanvas DB operation:", error);
      }
    }
  };

  const undoLastStroke = async () => {
    if (user?.id !== currentDrawerId) return; // only current drawer can undo

    try {
      const { data, error } = await supabase
        .from("drawing_strokes")
        .select("id")
        .eq("game_id", gameId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (error || !data) return;
      const lastId = data.id;
      await supabase.from("drawing_strokes").delete().eq("id", lastId);
      // Notify other clients to reload strokes
      liveChannelRef.current?.send({
        type: "broadcast",
        event: "undo",
        payload: { drawerId: user.id },
      });
      // Locally reload strokes for immediate feedback
      await fetchAndRenderStrokes();
    } catch (err) {
      console.error("Undo error", err);
    }
  };

  // Toggle between brush and eraser
  const toggleEraser = () => {
    setCurrentTool(currentTool === "brush" ? "eraser" : "brush");
  };

  // Set color and switch to brush tool
  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    setCurrentTool((prev) => (prev === "eraser" ? "brush" : prev));
  };

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        sizeDropdownRef.current &&
        !sizeDropdownRef.current.contains(event.target as Node)
      ) {
        setSizeDropdownOpen(false);
      }
    }
    if (sizeDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [sizeDropdownOpen]);

  // ────────────────────────────────────────────
  // Live-ink channel setup (receive)
  // ────────────────────────────────────────────
  useEffect(() => {
    if (!gameId) return;

    const liveChannel = supabase
      .channel(`drawing_live:${gameId}`)
      .on("broadcast", { event: "draw" }, ({ payload }) => {
        if (!fabricCanvasRef.current) return;
        if (payload.drawerId === user?.id) return; // ignore ourselves

        const { pathId, x, y, color, width } = payload;
        const canvas = fabricCanvasRef.current;

        const prev = remotePathMapRef.current[pathId];
        if (prev) {
          const line = new fabric.Line([prev.lastX, prev.lastY, x, y], {
            stroke: color,
            strokeWidth: width,
            selectable: false,
            evented: false,
          });
          canvas.add(line);
          canvas.renderAll();

          // Keep track of the temporary lines so we can delete them later
          if (!remoteLinesMapRef.current[pathId]) {
            remoteLinesMapRef.current[pathId] = [];
          }
          remoteLinesMapRef.current[pathId].push(line);
        }
        remotePathMapRef.current[pathId] = { lastX: x, lastY: y };
      })
      .on("broadcast", { event: "draw_end" }, ({ payload }) => {
        if (!fabricCanvasRef.current) return;
        if (payload.drawerId === user?.id) return;

        const { pathId } = payload;
        const canvas = fabricCanvasRef.current;

        const objs = remoteLinesMapRef.current[pathId];
        if (objs) {
          objs.forEach((obj) => canvas.remove(obj));
          delete remoteLinesMapRef.current[pathId];
        }
        delete remotePathMapRef.current[pathId];

        canvas.renderAll();
      })
      .on("broadcast", { event: "canvas_clear" }, ({ payload }) => {
        if (!fabricCanvasRef.current) return;
        if (payload.drawerId === user?.id) return; // ignore self
        const canvas = fabricCanvasRef.current;
        canvas.clear();
        canvas.backgroundColor = "white";
        canvas.renderAll();
        remoteLinesMapRef.current = {};
        remotePathMapRef.current = {} as any;
        fetchAndRenderStrokes();
      })
      .on("broadcast", { event: "undo" }, ({ payload }) => {
        if (!fabricCanvasRef.current) return;
        if (payload.drawerId === user?.id) return;
        fetchAndRenderStrokes();
      })
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR") {
          console.error("live-ink channel error", err);
        }
      });

    liveChannelRef.current = liveChannel;
    return () => {
      supabase.removeChannel(liveChannel);
    };
  }, [gameId]);

  // ────────────────────────────────────────────
  // Broadcast pointer positions while drawing (drawer only)
  // ────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    if (user?.id !== currentDrawerId) return; // only drawer sends

    const handleDownLive = () => {
      currentPathIdRef.current = crypto.randomUUID();
    };

    const handleMoveLive = (opt: any) => {
      if (!currentPathIdRef.current || !liveChannelRef.current) return;
      const now = Date.now();
      if (now - lastLiveSendRef.current < 25) return; // throttle
      lastLiveSendRef.current = now;

      const pointer = canvas.getPointer(opt.e as MouseEvent, false);
      liveChannelRef.current.send({
        type: "broadcast",
        event: "draw",
        payload: {
          drawerId: user.id,
          pathId: currentPathIdRef.current,
          x: pointer.x,
          y: pointer.y,
          color: currentTool === "eraser" ? "#FFFFFF" : selectedColor,
          width: currentTool === "eraser" ? brushSize * 1.5 : brushSize,
        },
      });
    };

    const handleUpLive = () => {
      if (!currentPathIdRef.current || !liveChannelRef.current) {
        currentPathIdRef.current = null;
        return;
      }

      // Notify viewers that this live stroke is finished so they can
      // remove the temporary line segments.
      liveChannelRef.current.send({
        type: "broadcast",
        event: "draw_end",
        payload: {
          drawerId: user.id,
          pathId: currentPathIdRef.current,
        },
      });

      currentPathIdRef.current = null;
    };

    canvas.on("mouse:down", handleDownLive);
    canvas.on("mouse:move", handleMoveLive);
    canvas.on("mouse:up", handleUpLive);

    return () => {
      canvas.off("mouse:down", handleDownLive);
      canvas.off("mouse:move", handleMoveLive);
      canvas.off("mouse:up", handleUpLive);
    };
  }, [user?.id, currentDrawerId, currentTool, selectedColor, brushSize]);

  return (
    <div>
      {/* Canvas with border */}
      <div className="canvas-container relative">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-75 rounded-lg z-10">
            <div className="text-gray-500">Loading canvas...</div>
          </div>
        )}
        <canvas ref={canvasRef} />
      </div>

      {/* Palette / Tools */}
      {!readOnly && (
        <div className="mt-4 p-4 bg-gray-100 rounded-lg">
          <div className="flex flex-wrap items-center gap-6 justify-start">
            {/* Color Palette - horizontal grid */}
            <div className="flex flex-col gap-2 order-1">
              <label className="text-sm font-medium text-gray-700">Color</label>
              <div className="grid grid-cols-11 gap-1">
                {palette.map((color) => (
                  <button
                    key={color}
                    onClick={() => handleColorSelect(color)}
                    className={`w-6 h-6 rounded-full border-2 transition-transform duration-100 ease-in-out ${
                      selectedColor.toUpperCase() === color.toUpperCase() &&
                      currentTool === "brush"
                        ? "border-blue-500 scale-110"
                        : "border-gray-400 hover:scale-110"
                    }`}
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>

            {/* Tools and Size - next to palette */}
            <div className="flex flex-col gap-2 order-2 ml-4">
              <label className="text-sm font-medium text-gray-700">Tools</label>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => setCurrentTool("brush")}
                  className={`w-10 h-10 flex items-center justify-center rounded-md border-2 transition-transform ${
                    currentTool === "brush"
                      ? "border-blue-500 bg-blue-100"
                      : "border-gray-400 hover:bg-gray-200"
                  }`}
                  title="Brush"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17.5 2.5c1 1.5 2 3.5 2 5.5 0 3-2.5 5.5-5.5 5.5-.5 0-1-.5-1-1 0-.8.4-1.5 1-2 .6-.5 1-1.2 1-2 0-.3-.1-.6-.2-1-.3-.5-.4-1-.3-1.5.1-.5.4-1 1-1.5.4-.4 1.2-1.5 2-3z"></path>
                    <path d="M9 12c0 1.7.9 3.3 2 4.5 1.1 1.2 2.3 2.3 3.5 3.5 1.7 1.7 2.5 4 2.5 5"></path>
                    <path d="M6 12a6 6 0 0 1 6-6"></path>
                  </svg>
                </button>
                <button
                  onClick={toggleEraser}
                  className={`w-10 h-10 flex items-center justify-center rounded-md border-2 transition-transform ${
                    currentTool === "eraser"
                      ? "border-blue-500 bg-blue-100"
                      : "border-gray-400 hover:bg-gray-200"
                  }`}
                  title="Eraser"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path>
                    <path d="M22 21H7"></path>
                    <path d="m5 11 9 9"></path>
                  </svg>
                </button>
                {/* Size Dropdown Button */}
                <div className="relative" ref={sizeDropdownRef}>
                  <button
                    className="w-10 h-10 flex items-center justify-center rounded-md border-2 border-gray-400 bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition relative"
                    onClick={() => setSizeDropdownOpen((open) => !open)}
                    type="button"
                    title="Brush size"
                  >
                    <span className="flex items-center justify-center w-full h-full">
                      <span
                        style={{
                          width: brushSize,
                          height: brushSize,
                          backgroundColor:
                            currentTool === "eraser" ? "#fff" : selectedColor,
                          borderRadius: "50%",
                          border: "1px solid #888",
                          display: "inline-block",
                        }}
                      />
                    </span>
                  </button>
                  {sizeDropdownOpen && (
                    <div className="absolute z-20 mb-2 left-0 bottom-full bg-white border border-gray-300 rounded-md shadow-lg flex flex-col">
                      {sizeOptions.map((size) => (
                        <button
                          key={size}
                          onClick={() => {
                            setBrushSize(size);
                            setSizeDropdownOpen(false);
                          }}
                          className={`w-10 h-10 flex items-center justify-center hover:bg-blue-100 transition rounded-md ${
                            brushSize === size ? "bg-blue-100" : ""
                          }`}
                          type="button"
                        >
                          <span
                            style={{
                              width: size,
                              height: size,
                              backgroundColor:
                                currentTool === "eraser"
                                  ? "#fff"
                                  : selectedColor,
                              borderRadius: "50%",
                              border: "1px solid #888",
                              display: "inline-block",
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Undo */}
                <button
                  onClick={undoLastStroke}
                  className={`w-10 h-10 flex items-center justify-center rounded-md border-2 transition-transform border-gray-400 hover:bg-gray-200`}
                  title="Undo"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 12h18"></path>
                    <path d="M3 12 9 6"></path>
                    <path d="M3 12 9 18"></path>
                  </svg>
                </button>
                {/* Clear Canvas Button */}
                <button
                  onClick={clearCanvas}
                  className="w-10 h-10 flex items-center justify-center rounded-md border-2 border-gray-400 hover:bg-red-100 hover:border-red-500 transition-transform"
                  title="Clear canvas"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18"></path>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                    <line x1="10" x2="10" y1="11" y2="17"></line>
                    <line x1="14" x2="14" y1="11" y2="17"></line>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DrawingCanvas;
