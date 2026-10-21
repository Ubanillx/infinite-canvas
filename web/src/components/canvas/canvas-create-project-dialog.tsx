import { Button, Form, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

type CreateProjectValues = { title: string; description?: string };

export function CanvasCreateProjectDialog({ open, folderId = null, onCancel, onCreated }: { open: boolean; folderId?: string | null; onCancel: () => void; onCreated: (id: string) => void }) {
    const { t } = useTranslation();
    const [form] = Form.useForm<CreateProjectValues>();
    const createProject = useCanvasStore((state) => state.createProject);
    const cancel = () => {
        form.resetFields();
        onCancel();
    };
    const create = (values: CreateProjectValues) => {
        const id = createProject(values.title.trim(), folderId, values.description?.trim() || "");
        form.resetFields();
        onCreated(id);
    };

    return <Modal title={t("canvas.create")} open={open} onCancel={cancel} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={create}>
            <Form.Item name="title" label={t("canvas.createDialog.name")} rules={[{ required: true, whitespace: true, message: t("canvas.createDialog.nameRequired") }]}>
                <Input autoFocus />
            </Form.Item>
            <Form.Item name="description" label={t("canvas.createDialog.description")}>
                <Input.TextArea rows={3} />
            </Form.Item>
            <div className="flex justify-end gap-2">
                <Button onClick={cancel}>{t("common.cancel")}</Button>
                <Button type="primary" htmlType="submit">{t("canvas.create")}</Button>
            </div>
        </Form>
    </Modal>;
}
