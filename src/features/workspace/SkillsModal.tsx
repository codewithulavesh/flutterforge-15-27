import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { GeneratorPanel } from './GeneratorPanel';

export function SkillsModal({ isOpen, onClose, projectId }: { isOpen: boolean; onClose: () => void; projectId?: string }) {
  return <Dialog open={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="generator-dialog">
      <DialogTitle>Generator settings</DialogTitle>
      <DialogDescription>Configure skills, connectors, and specialist agents for this project.</DialogDescription>
      {projectId && <GeneratorPanel key={projectId} projectId={projectId} />}
    </DialogContent>
  </Dialog>;
}
