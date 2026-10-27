import { useEffect, useRef } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function HomeAmbientBackground() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const themeName = useThemeStore((state) => state.theme);

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        const page = canvas?.parentElement;
        if (!canvas || !context || !page) return;

        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        const theme = canvasThemes[themeName];
        const accent = getComputedStyle(page).getPropertyValue("--home-accent").trim();
        let width = 0;
        let height = 0;
        let frame = 0;
        let lastTime = 0;
        let elapsed = 0;
        const pointer = { x: 0.7, y: 0.55, targetX: 0.7, targetY: 0.55, strength: 0, active: false };

        const draw = (now: number) => {
            frame = 0;
            const delta = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
            lastTime = now;
            if (!motion.matches) elapsed += delta;
            const ease = 1 - Math.exp(-delta * 5);
            pointer.x += (pointer.targetX - pointer.x) * ease;
            pointer.y += (pointer.targetY - pointer.y) * ease;
            pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * ease;
            page.style.setProperty("--home-pointer-x", `${pointer.x * 100}%`);
            page.style.setProperty("--home-pointer-y", `${pointer.y * 100}%`);
            page.style.setProperty("--home-shift-x", `${(pointer.x - 0.7) * 28}px`);
            page.style.setProperty("--home-shift-y", `${(pointer.y - 0.55) * 22}px`);
            context.clearRect(0, 0, width, height);

            const color = context.createLinearGradient(0, 0, width, height * 0.6);
            color.addColorStop(0, theme.canvas.dot);
            color.addColorStop(0.5, accent);
            color.addColorStop(1, theme.node.label);
            context.strokeStyle = color;
            const phase = elapsed * 0.19;
            const radius = Math.min(width, height) * 0.38;
            const pointerX = pointer.x * width;
            const pointerY = pointer.y * height;

            // Closely spaced curves form a fabric; the pointer bends its local surface.
            for (let row = 0; row < 38; row++) {
                const depth = row / 37;
                context.beginPath();
                context.lineWidth = row % 6 === 0 ? 1 : 0.55;
                context.globalAlpha = (themeName === "dark" ? 0.2 : 0.17) * Math.sin(depth * Math.PI);
                for (let step = 0; step <= 88; step++) {
                    const u = step / 88;
                    let x = u * (width + 160) - 80;
                    let y = height * (0.71 + depth * 0.33)
                        + Math.sin(u * 7 + phase + depth * 1.5) * height * 0.13
                        + Math.cos(u * 4 - phase * 0.6 + depth) * height * 0.06;
                    if (pointer.strength > 0.001 && !motion.matches) {
                        const dx = x - pointerX;
                        const dy = y - pointerY;
                        const influence = Math.exp(-(dx * dx + dy * dy) / (radius * radius)) * pointer.strength;
                        x += dx * influence * 0.12;
                        y += Math.sin(influence * Math.PI) * 42 - influence * 68;
                    }
                    if (step === 0) context.moveTo(x, y);
                    else context.lineTo(x, y);
                }
                context.stroke();
            }

            context.fillStyle = theme.node.label;
            for (let index = 0; index < 42; index++) {
                const seed = index * 137.508;
                const x = ((Math.sin(seed) * 0.5 + 0.5) * width + Math.sin(elapsed * 0.12 + seed) * 12);
                const y = (Math.cos(seed * 0.7) * 0.5 + 0.5) * height + Math.cos(elapsed * 0.16 + seed) * 9;
                const distance = Math.hypot(x - pointerX, y - pointerY);
                context.globalAlpha = 0.09 + Math.max(0, 1 - distance / radius) * 0.4 * pointer.strength;
                context.beginPath();
                context.arc(x, y, index % 5 === 0 ? 1.2 : 0.65, 0, Math.PI * 2);
                context.fill();
            }
            context.globalAlpha = 1;
            if (!motion.matches && !document.hidden) frame = requestAnimationFrame(draw);
        };

        const resize = () => {
            width = page.clientWidth;
            height = page.clientHeight;
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            if (motion.matches) draw(performance.now());
        };
        const move = (event: PointerEvent) => {
            if (motion.matches || event.pointerType === "touch") return;
            const rect = page.getBoundingClientRect();
            pointer.targetX = (event.clientX - rect.left) / rect.width;
            pointer.targetY = (event.clientY - rect.top) / rect.height;
            pointer.active = true;
        };
        const reset = () => {
            pointer.targetX = 0.7;
            pointer.targetY = 0.55;
            pointer.active = false;
        };
        const restart = () => {
            cancelAnimationFrame(frame);
            frame = 0;
            lastTime = 0;
            if (motion.matches) reset();
            if (!document.hidden) draw(performance.now());
        };
        const observer = new ResizeObserver(resize);
        observer.observe(page);
        resize();
        restart();
        page.addEventListener("pointermove", move, { passive: true });
        page.addEventListener("pointerleave", reset);
        window.addEventListener("blur", reset);
        motion.addEventListener("change", restart);
        document.addEventListener("visibilitychange", restart);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            page.removeEventListener("pointermove", move);
            page.removeEventListener("pointerleave", reset);
            window.removeEventListener("blur", reset);
            motion.removeEventListener("change", restart);
            document.removeEventListener("visibilitychange", restart);
        };
    }, [themeName]);

    return <><div className="home-nebula" aria-hidden="true" /><canvas ref={canvasRef} className="home-field" aria-hidden="true" /></>;
}
