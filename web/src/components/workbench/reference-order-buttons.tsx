import { Button } from "antd";
import { ArrowLeft, ArrowRight } from "lucide-react";

export function ReferenceOrderButtons({ index, total, onMove, flat = false }: { index: number; total: number; onMove: (offset: number) => void; flat?: boolean }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className={`!h-6 !w-6 !min-w-6 !rounded-full !p-0 ${flat ? "!border-border !bg-card/90 !text-foreground !shadow-none" : "!bg-white/85 !shadow-sm"}`} icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className={`!h-6 !w-6 !min-w-6 !rounded-full !p-0 ${flat ? "!border-border !bg-card/90 !text-foreground !shadow-none" : "!bg-white/85 !shadow-sm"}`} icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}
