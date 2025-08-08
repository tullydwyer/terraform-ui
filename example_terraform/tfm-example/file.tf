resource "local_file" "module_file" {
  content  = "foo!"
  filename = "out/${var.name}"
}