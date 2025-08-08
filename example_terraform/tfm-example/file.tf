resource "local_file" "example" {
  content  = "foo!"
  filename = "out/foo.bar"
}