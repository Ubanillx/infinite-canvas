import { useEffect, useRef } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";

type Particle = { x: number; y: number; vx: number; vy: number };

export function WorkspaceAmbientBackground({ theme }: { theme: CanvasTheme }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const pointer = { x: -1000, y: -1000, active: false };
        let particles: Particle[] = [];
        let width = 0;
        let height = 0;
        let frame = 0;

        const draw = () => {
            context.clearRect(0, 0, width, height);
            const positions = particles.map((particle) => {
                if (!reducedMotion) {
                    particle.x += particle.vx;
                    particle.y += particle.vy;
                    if (particle.x < 0 || particle.x > width) particle.vx *= -1;
                    if (particle.y < 0 || particle.y > height) particle.vy *= -1;
                }
                const distance = Math.hypot(pointer.x - particle.x, pointer.y - particle.y);
                const pull = pointer.active ? Math.max(0, 1 - distance / 250) * 0.13 : 0;
                return { x: particle.x + (pointer.x - particle.x) * pull, y: particle.y + (pointer.y - particle.y) * pull };
            });

            context.strokeStyle = theme.canvas.dot;
            context.lineWidth = 1;
            positions.forEach((point, index) => {
                for (let next = index + 1; next < positions.length; next++) {
                    const other = positions[next];
                    const distance = Math.hypot(point.x - other.x, point.y - other.y);
                    if (distance > 180) continue;
                    context.globalAlpha = (1 - distance / 180) * 0.9;
                    context.beginPath();
                    context.moveTo(point.x, point.y);
                    context.lineTo(other.x, other.y);
                    context.stroke();
                }
                if (pointer.active) {
                    const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
                    if (distance < 270) {
                        context.strokeStyle = theme.node.activeStroke;
                        context.globalAlpha = (1 - distance / 270) * 0.17;
                        context.beginPath();
                        context.moveTo(point.x, point.y);
                        context.lineTo(pointer.x, pointer.y);
                        context.stroke();
                        context.strokeStyle = theme.canvas.dot;
                    }
                }
            });

            context.globalAlpha = 1;
            context.fillStyle = theme.canvas.dot;
            positions.forEach((point) => {
                context.beginPath();
                context.arc(point.x, point.y, 1.6, 0, Math.PI * 2);
                context.fill();
            });
            if (pointer.active) {
                const glow = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 210);
                glow.addColorStop(0, theme.canvas.selectionFill);
                glow.addColorStop(1, "transparent");
                context.fillStyle = glow;
                context.fillRect(pointer.x - 210, pointer.y - 210, 420, 420);
            }
            if (!reducedMotion) frame = window.requestAnimationFrame(draw);
        };

        const resize = () => {
            width = window.innerWidth;
            height = window.innerHeight;
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            particles = Array.from({ length: Math.min(72, Math.max(28, Math.round(width * height / 32000))) }, () => ({
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * 0.35,
                vy: (Math.random() - 0.5) * 0.35,
            }));
            if (reducedMotion) draw();
        };
        const movePointer = (event: PointerEvent) => {
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            pointer.active = true;
        };
        const hidePointer = () => { pointer.active = false; };
        const visibilityChanged = () => {
            window.cancelAnimationFrame(frame);
            if (!document.hidden && !reducedMotion) frame = window.requestAnimationFrame(draw);
        };

        resize();
        if (!reducedMotion) frame = window.requestAnimationFrame(draw);
        window.addEventListener("resize", resize);
        window.addEventListener("pointermove", movePointer, { passive: true });
        window.addEventListener("blur", hidePointer);
        document.addEventListener("visibilitychange", visibilityChanged);
        return () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener("resize", resize);
            window.removeEventListener("pointermove", movePointer);
            window.removeEventListener("blur", hidePointer);
            document.removeEventListener("visibilitychange", visibilityChanged);
        };
    }, [theme]);

    return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0" />;
}
